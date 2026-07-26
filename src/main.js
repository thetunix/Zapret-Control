const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, globalShortcut, powerMonitor } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Zapret Control Center';
const UPDATE_REPO = 'Flowseal/zapret-discord-youtube';
const APP_REPO = 'thetunix/Zapret-Control';
const VERSION_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/.service/version.txt`;
const APP_VERSION_URL = `https://raw.githubusercontent.com/${APP_REPO}/main/app-version.txt`;
const APP_RELEASE_API_URL = `https://api.github.com/repos/${APP_REPO}/releases/latest`;
const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const SERVICE_NAME = 'zapret';
const SERVICE_SDDL = 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRPWPLO;;;IU)(A;;LCRPWPLO;;;AU)';
const TOGGLE_HOTKEY = 'Control+Alt+Z';
const WINDOW_UNLOAD_DELAY_MS = 12000;
const LOG_MAX_BYTES = 512 * 1024;
const LOG_TAIL_BYTES = 192 * 1024;
const STARTUP_DEBUG_MAX_BYTES = 64 * 1024;
const RECENT_LOGS_LIMIT = 300;
const WATCHDOG_MAX_ATTEMPTS = 3;
const WATCHDOG_WINDOW_MS = 5 * 60 * 1000;
const POLL_INTERVAL_FOCUSED_MS = 5000;
const POLL_INTERVAL_VISIBLE_MS = 15000;
const POLL_INTERVAL_TRAY_MS = 60000;
const POLL_INTERVAL_ECO_TRAY_MS = 180000;
const POLL_INTERVAL_TEST_MS = 2000;
const THEMES = [
  'figma', 'aurora', 'graphite', 'ember', 'glacier', 'orchid', 'forest', 'ruby', 'noir',
  'midnight', 'sunset', 'matrix', 'cyber', 'sakura', 'mocha', 'nord', 'dracula', 'gold', 'ocean',
  'custom'
];

const rootDir = resolveZapretRoot();
const binDir = path.join(rootDir, 'bin');
const listsDir = path.join(rootDir, 'lists');
const utilsDir = path.join(rootDir, 'utils');
const winwsExe = path.join(binDir, 'winws.exe');

let mainWindow = null;
let tray = null;
let trayMenuSignature = null;
let isQuitting = false;
let winwsChild = null;
let settings = null;
let settingsFile = null;
let logFile = null;
let logFileBytes = null;
let startupDebugFile = null;
let recentLogs = [];
let activeTest = null;
let startZapretInFlight = null;
let pollTimer = null;
let pollIntervalMs = 0;
let windowUnloadTimer = null;
let intentionalStop = false;
let watchdogAttempts = [];
let watchdogTimer = null;
let lastActiveConfig = null;
let hotkeyRegistered = false;
let lastUpdate = {
  status: 'idle',
  localVersion: null,
  latestVersion: null,
  message: 'Проверка ещё не запускалась'
};
let lastAppUpdate = {
  status: 'idle',
  version: null,
  message: 'Проверка обновлений приложения ещё не запускалась',
  progress: 0
};
let pendingAppInstallerPath = null;
let cachedAdmin = null;
let cachedServiceConfigName = undefined;
let runtimeStatus = {
  running: { active: false, processes: [], managedCount: 0, externalCount: 0 },
  service: { installed: false, state: 'NOT_INSTALLED', configName: null },
  refreshedAt: 0
};
let runtimeStatusPromise = null;
let buildStatePromise = null;
let configsCache = null;
const RUNTIME_STATUS_TTL_MS = 2500;
const CONFIGS_TTL_MS = 30000;

const defaultSettings = {
  selectedConfig: 'general.bat',
  bestConfig: 'general.bat',
  theme: 'figma',
  customTheme: {
    accent: '#7c5cff',
    accent2: '#32d6c8',
    accent3: '#5b7bff',
    bg: '#0b0b0f'
  },
  launchAtLogin: true,
  autoStartZapret: true,
  autoUpdateZapret: true,
  startMinimized: false,
  gameFilterMode: 'disabled',
  testMode: 'fast',
  ambientIntensity: 72,
  glassBlur: 18,
  motionSpeed: 55,
  unloadWindowInTray: true,
  ecoMode: true,
  disableGpu: false,
  watchdog: true,
  toggleHotkey: true
};

applyEarlySettings();

const useSingleInstanceLock = shouldUseSingleInstanceLock();
let ownsSingleInstanceLock = !useSingleInstanceLock || app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  writeStartupDebug('quit: single-instance lock is owned by another process');
  console.error('Zapret Control Center is already running. Existing instance owns the single-instance lock.');
  app.quit();
} else {
  if (useSingleInstanceLock) {
    app.on('second-instance', () => showMainWindow());
  }
  app.whenReady().then(bootstrap).catch((error) => {
    writeStartupDebug(`bootstrap error: ${error.stack || error.message || error}`);
    console.error(error);
    app.quit();
  });
}

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  stopStatusPolling();
  cancelWindowUnload();
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
});

app.on('will-quit', () => {
  if (hotkeyRegistered) {
    globalShortcut.unregisterAll();
    hotkeyRegistered = false;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

function shouldUseSingleInstanceLock() {
  return app.isPackaged || process.argv.includes('--startup') || process.argv.includes('--admin');
}

async function bootstrap() {
  writeStartupDebug(`bootstrap start: argv=${JSON.stringify(process.argv)}, packaged=${app.isPackaged}, defaultApp=${process.defaultApp}`);
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  logFile = path.join(app.getPath('userData'), 'zapret-control.log');
  settings = loadSettings();

  if (await shouldRelaunchElevated()) {
    log('Перезапуск с правами администратора');
    const relaunched = await relaunchAsAdmin({ elevatedAttempt: true, releaseLock: true });
    if (relaunched) {
      isQuitting = true;
      app.quit();
      return;
    }
    log('Не удалось перезапуститься от администратора, продолжаю обычный запуск', 'warn');
  }

  ensureZapretFiles();
  syncLoginItem();

  const startHidden = process.argv.includes('--startup') && settings.startMinimized;

  createTray();
  writeStartupDebug('tray created');
  registerIpc();
  registerToggleHotkey();
  registerPowerEvents();
  cleanupStaleInstallers();

  if (startHidden) {
    writeStartupDebug('start hidden: окно не создаётся, экономия памяти');
  } else {
    createWindow();
    writeStartupDebug('window created');
    showMainWindow();
  }

  scheduleStatusPoll(true);
  log(`Приложение запущено. Корень zapret: ${rootDir}`);

  const runningAtLaunch = await getWinwsStatus();
  if (runningAtLaunch.active) {
    log(`Подхвачен уже запущенный winws.exe: ${runningAtLaunch.processes.length} процесс(ов)`);
  }

  if (app.isPackaged) {
    setTimeout(() => {
      checkForAppUpdate().catch((error) => {
        log(`Не удалось проверить обновление приложения: ${error.message}`, 'error');
      });
    }, 6000);
  }

  if (settings.autoUpdateZapret) {
    checkForZapretUpdate({ apply: true }).catch((error) => {
      log(`Ошибка автообновления: ${error.message}`, 'error');
    });
  }

  if (settings.autoStartZapret && !runningAtLaunch.active) {
    setTimeout(() => {
      startZapret(settings.bestConfig || settings.selectedConfig, { remember: false, reason: 'autostart' })
        .catch((error) => log(`Автозапуск zapret не удался: ${error.message}`, 'error'));
    }, 1800);
  }
}

function resolveStartupDebugFile() {
  if (startupDebugFile) return startupDebugFile;
  try {
    startupDebugFile = path.join(app.getPath('userData'), 'startup-debug.log');
  } catch {
    startupDebugFile = path.join(os.tmpdir(), 'zapret-startup-debug.log');
  }
  return startupDebugFile;
}

function writeStartupDebug(message) {
  try {
    const file = resolveStartupDebugFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > STARTUP_DEBUG_MAX_BYTES) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}${os.EOL}`, 'utf8');
  } catch {}
}

function resolveZapretRoot() {
  const appBase = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
  const candidates = [
    process.env.ZAPRET_ROOT,
    path.join(appBase, 'zapret'),
    appBase,
    path.join(process.cwd(), 'zapret'),
    process.cwd()
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'bin', 'winws.exe')) && fs.existsSync(path.join(candidate, 'service.bat'))) {
      return candidate;
    }
  }

  return candidates[0] || process.cwd();
}

async function shouldRelaunchElevated() {
  if (process.platform !== 'win32') return false;
  if (process.argv.includes('--elevated-attempted')) return false;
  if (process.argv.includes('--no-admin-auto')) return false;
  if (await isAdministrator()) return false;

  const explicitAdmin = process.argv.includes('--admin');

  return explicitAdmin;
}

function hasWindow() {
  return Boolean(mainWindow) && !mainWindow.isDestroyed();
}

function isWindowVisible() {
  return hasWindow() && mainWindow.isVisible();
}

function createWindow() {
  if (hasWindow()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: '#101318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false
    }
  });

  const window = mainWindow;
  Menu.setApplicationMenu(null);
  window.loadFile(path.join(__dirname, 'index.html'));

  window.on('minimize', (event) => {
    event.preventDefault();
    hideMainWindow();
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindow();
    }
  });

  window.on('show', () => {
    cancelWindowUnload();
    scheduleStatusPoll(true);
  });

  window.on('hide', () => {
    scheduleWindowUnload();
    scheduleStatusPoll(true);
  });

  window.on('focus', () => scheduleStatusPoll(true));
  window.on('blur', () => scheduleStatusPoll(true));

  window.on('closed', () => {
    // Окно могло быть пересоздано — обнуляем только свою ссылку.
    if (mainWindow === window) mainWindow = null;
    trayMenuSignature = null;
    scheduleStatusPoll(true);
  });

  return window;
}

function scheduleWindowUnload() {
  cancelWindowUnload();
  if (!settings?.unloadWindowInTray) return;

  windowUnloadTimer = setTimeout(() => {
    windowUnloadTimer = null;
    unloadWindow();
  }, WINDOW_UNLOAD_DELAY_MS);
  windowUnloadTimer.unref?.();
}

function cancelWindowUnload() {
  if (windowUnloadTimer) {
    clearTimeout(windowUnloadTimer);
    windowUnloadTimer = null;
  }
}

function canUnloadWindow() {
  if (isQuitting) return false;
  if (activeTest) return false;
  if (lastAppUpdate.status === 'downloading') return false;
  if (lastUpdate.status === 'downloading' || lastUpdate.status === 'installing') return false;
  return true;
}

function unloadWindow(force = false) {
  if (!hasWindow()) return false;
  if (mainWindow.isVisible() && !force) return false;
  if (!canUnloadWindow()) return false;

  const target = mainWindow;
  mainWindow = null;
  target.destroy();
  log('Интерфейс выгружен из памяти, работает только трей');
  scheduleStatusPoll(true);
  return true;
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="7" fill="#141820"/>
        <path d="M8 17.5c4-10 12-10 16 0" fill="none" stroke="#5eead4" stroke-width="3" stroke-linecap="round"/>
        <path d="M9 22h14" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>
        <circle cx="16" cy="16" r="3" fill="#f8fafc"/>
      </svg>`)
  );

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('double-click', showMainWindow);
  updateTray();
}

function updateTray() {
  if (!tray || tray.isDestroyed?.()) return;

  const running = runtimeStatus.running;
  const service = runtimeStatus.service;
  const active = Boolean(running?.active);
  const configLabel = (settings?.selectedConfig || '').replace(/\.bat$/i, '');
  const signature = [active, service?.state, configLabel, settings?.autoStartZapret, hasWindow()].join('|');
  if (signature === trayMenuSignature) return;
  trayMenuSignature = signature;

  const configs = getConfigs().slice(0, 24);
  const statusLabel = active ? 'zapret работает' : 'zapret остановлен';

  tray.setToolTip(`${APP_NAME}\n${statusLabel}${configLabel ? ` · ${configLabel}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: showMainWindow },
    {
      label: active ? 'Остановить zapret' : 'Включить zapret',
      click: () => {
        const task = active
          ? stopZapretProcesses({ stopService: true })
          : startZapret(settings.bestConfig || settings.selectedConfig, { remember: false, reason: 'tray' });
        task.catch((error) => log(error.message, 'error'));
      }
    },
    { label: 'Перезапустить zapret', click: () => restartZapret().catch((error) => log(error.message, 'error')) },
    {
      label: 'Конфиг',
      submenu: configs.map((config) => ({
        label: config.label,
        type: 'radio',
        checked: config.name === settings.selectedConfig,
        click: () => {
          startZapret(config.name, { remember: true, reason: 'tray-config' })
            .catch((error) => log(error.message, 'error'));
        }
      }))
    },
    { type: 'separator' },
    {
      label: 'Автозапуск zapret',
      type: 'checkbox',
      checked: Boolean(settings?.autoStartZapret),
      click: (item) => {
        settings.autoStartZapret = item.checked;
        saveSettings();
        sendState().catch(() => {});
      }
    },
    { label: 'Папка с логами', click: () => shell.openPath(path.dirname(logFile)) },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function showMainWindow() {
  cancelWindowUnload();

  if (!hasWindow()) {
    const window = createWindow();
    const reveal = () => {
      if (window.isDestroyed() || window.isVisible()) return;
      window.show();
      window.focus();
    };
    window.once('ready-to-show', reveal);
    // Страховка: если ready-to-show не придёт, окно всё равно должно появиться.
    setTimeout(reveal, 3000).unref?.();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!hasWindow()) return;
  mainWindow.hide();
}

function toggleMainWindow() {
  if (isWindowVisible() && mainWindow.isFocused()) {
    hideMainWindow();
    return;
  }
  showMainWindow();
}

function registerToggleHotkey() {
  if (hotkeyRegistered) {
    globalShortcut.unregister(TOGGLE_HOTKEY);
    hotkeyRegistered = false;
  }
  if (!settings?.toggleHotkey) return;

  try {
    hotkeyRegistered = globalShortcut.register(TOGGLE_HOTKEY, toggleMainWindow);
    if (!hotkeyRegistered) log(`Горячая клавиша ${TOGGLE_HOTKEY} занята другой программой`, 'warn');
  } catch (error) {
    log(`Не удалось назначить горячую клавишу: ${error.message}`, 'warn');
  }
}

function registerPowerEvents() {
  try {
    powerMonitor.on('resume', () => {
      log('Система вышла из сна — проверяю zapret');
      setTimeout(() => {
        refreshRuntimeStatus(true)
          .then(() => {
            if (settings.watchdog && !runtimeStatus.running.active && lastActiveConfig) {
              triggerWatchdogRestart('после выхода из сна');
            }
            return sendState({ refresh: false });
          })
          .catch(() => {});
      }, 4000);
    });
  } catch {}
}

function computePollInterval() {
  if (activeTest) return POLL_INTERVAL_TEST_MS;
  if (isWindowVisible()) {
    return mainWindow.isFocused() ? POLL_INTERVAL_FOCUSED_MS : POLL_INTERVAL_VISIBLE_MS;
  }
  return settings?.ecoMode ? POLL_INTERVAL_ECO_TRAY_MS : POLL_INTERVAL_TRAY_MS;
}

function scheduleStatusPoll(reschedule = false) {
  const interval = computePollInterval();
  if (pollTimer && !reschedule && interval === pollIntervalMs) return;

  stopStatusPolling();
  if (isQuitting) return;

  pollIntervalMs = interval;
  pollTimer = setTimeout(runStatusPoll, interval);
  pollTimer.unref?.();
}

function stopStatusPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function runStatusPoll() {
  pollTimer = null;
  try {
    const previousActive = runtimeStatus.running.active;
    await refreshRuntimeStatus(true);
    if (runtimeStatus.running.active) lastActiveConfig = settings.selectedConfig;
    if (previousActive && !runtimeStatus.running.active && !intentionalStop && settings.watchdog) {
      triggerWatchdogRestart('процесс winws.exe пропал');
    }
    await sendState({ refresh: false });
  } catch {
    // статус обновим на следующем тике
  } finally {
    scheduleStatusPoll(true);
  }
}

function triggerWatchdogRestart(reason) {
  if (watchdogTimer || isQuitting || activeTest || startZapretInFlight) return;

  const now = Date.now();
  watchdogAttempts = watchdogAttempts.filter((stamp) => now - stamp < WATCHDOG_WINDOW_MS);
  if (watchdogAttempts.length >= WATCHDOG_MAX_ATTEMPTS) {
    log('Watchdog: слишком много перезапусков подряд, жду', 'warn');
    return;
  }

  watchdogAttempts.push(now);
  log(`Watchdog: ${reason}, перезапускаю zapret`, 'warn');
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    startZapret(lastActiveConfig || settings.bestConfig || settings.selectedConfig, { remember: false, reason: 'watchdog' })
      .catch((error) => log(`Watchdog: перезапуск не удался — ${error.message}`, 'error'));
  }, 2500);
  watchdogTimer.unref?.();
}

async function restartZapret(configName) {
  await stopZapretProcesses({ stopService: true });
  return startZapret(configName || settings.selectedConfig, { remember: true, reason: 'manual' });
}

function cleanupStaleInstallers() {
  try {
    const dir = app.getPath('temp');
    for (const name of fs.readdirSync(dir)) {
      if (!/^Zapret-Control-Center-Setup-.*\.exe$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (pendingAppInstallerPath && path.normalize(file).toLowerCase() === path.normalize(pendingAppInstallerPath).toLowerCase()) continue;
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true });
    }
  } catch {}
}

function registerIpc() {
  ipcMain.handle('state:get', async () => buildState());
  ipcMain.handle('window:hide', () => {
    hideMainWindow();
    return true;
  });
  ipcMain.handle('window:unload', () => {
    hideMainWindow();
    cancelWindowUnload();
    setTimeout(() => unloadWindow(true), 150);
    return true;
  });
  ipcMain.handle('app:metrics', () => collectMetrics());
  ipcMain.handle('admin:relaunch', async () => {
    const relaunched = await relaunchAsAdmin({ elevatedAttempt: true, releaseLock: true });
    if (relaunched) {
      isQuitting = true;
      app.quit();
    }
    return relaunched;
  });
  ipcMain.handle('path:openRoot', () => shell.openPath(rootDir));
  ipcMain.handle('path:openLogs', () => shell.openPath(path.dirname(logFile)));

  ipcMain.handle('zapret:start', async (_event, configName) => {
    await startZapret(configName || settings.selectedConfig, { remember: true, reason: 'manual' });
    return buildState();
  });
  ipcMain.handle('zapret:stop', async () => {
    await stopZapretProcesses({ stopService: true });
    return buildState();
  });
  ipcMain.handle('zapret:restart', async (_event, configName) => {
    await restartZapret(configName);
    return buildState();
  });

  ipcMain.handle('settings:set', async (_event, patch) => {
    const safe = sanitizeSettingsPatch(patch);
    settings = { ...settings, ...safe };
    if (patch?.gameFilterMode) setGameFilterMode(settings.gameFilterMode);
    saveSettings();
    syncLoginItem();
    if ('toggleHotkey' in safe) registerToggleHotkey();
    if ('ecoMode' in safe) scheduleStatusPoll(true);
    if ('unloadWindowInTray' in safe && !safe.unloadWindowInTray) cancelWindowUnload();
    trayMenuSignature = null;
    updateTray();
    return buildState();
  });

  ipcMain.handle('lists:getGeneral', () => readGeneralList());
  ipcMain.handle('lists:addGeneral', (_event, domain) => addGeneralDomain(domain));
  ipcMain.handle('lists:removeGeneral', (_event, domain) => removeGeneralDomain(domain));
  ipcMain.handle('lists:saveGeneral', (_event, domains) => saveGeneralDomains(domains));

  ipcMain.handle('logs:read', () => readLogFile());
  ipcMain.handle('logs:clear', () => {
    recentLogs = [];
    fs.writeFileSync(logFile, '', 'utf8');
    fs.rmSync(`${logFile}.1`, { force: true });
    logFileBytes = 0;
    send('log:cleared', true);
    return true;
  });

  ipcMain.handle('updates:check', async (_event, options) => {
    await checkForZapretUpdate({ apply: Boolean(options?.apply) });
    return buildState();
  });
  ipcMain.handle('updates:openRelease', () => shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`));

  ipcMain.handle('app-update:check', async () => {
    await checkForAppUpdate();
    return buildState();
  });
  ipcMain.handle('app-update:install', () => {
    if (lastAppUpdate.status !== 'downloaded' || !pendingAppInstallerPath || !fs.existsSync(pendingAppInstallerPath)) {
      throw new Error('Обновление ещё не скачано');
    }
    isQuitting = true;
    spawn(pendingAppInstallerPath, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  });

  ipcMain.handle('tests:start', async (_event, options) => {
    if (activeTest) throw new Error('Тест уже запущен');
    runConfigTests(options || {}).catch((error) => {
      log(`Тесты завершились с ошибкой: ${error.message}`, 'error');
      send('tests:error', { message: error.message });
    });
    return true;
  });
  ipcMain.handle('tests:cancel', () => {
    if (activeTest) activeTest.cancelled = true;
    return true;
  });

  ipcMain.handle('service:install', async (_event, configName) => {
    await installZapretService(configName || settings.bestConfig || settings.selectedConfig);
    return buildState();
  });
  ipcMain.handle('service:remove', async () => {
    await removeZapretService();
    return buildState();
  });
}

function loadSettings() {
  try {
    const file = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return {
      ...defaultSettings,
      ...file,
      customTheme: sanitizeCustomTheme(file.customTheme || {}),
      gameFilterMode: readGameFilterMode(file.gameFilterMode)
    };
  } catch {
    return { ...defaultSettings, gameFilterMode: readGameFilterMode(defaultSettings.gameFilterMode) };
  }
}

// Читается до app.whenReady(): аппаратное ускорение можно отключить только там.
function applyEarlySettings() {
  try {
    const file = path.join(app.getPath('userData'), 'settings.json');
    const early = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (early?.disableGpu) {
      app.disableHardwareAcceleration();
      app.commandLine.appendSwitch('disable-gpu-compositing');
    }
  } catch {}
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

function sanitizeSettingsPatch(patch) {
  const safe = {};
  if (!patch || typeof patch !== 'object') return safe;
  if (typeof patch.selectedConfig === 'string') safe.selectedConfig = patch.selectedConfig;
  if (typeof patch.bestConfig === 'string') safe.bestConfig = patch.bestConfig;
  if (typeof patch.theme === 'string' && THEMES.includes(patch.theme)) safe.theme = patch.theme;
  if (patch.customTheme && typeof patch.customTheme === 'object') {
    const custom = sanitizeCustomTheme(patch.customTheme);
    if (custom) safe.customTheme = custom;
  }
  if (typeof patch.launchAtLogin === 'boolean') safe.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.autoStartZapret === 'boolean') safe.autoStartZapret = patch.autoStartZapret;
  if (typeof patch.autoUpdateZapret === 'boolean') safe.autoUpdateZapret = patch.autoUpdateZapret;
  if (typeof patch.startMinimized === 'boolean') safe.startMinimized = patch.startMinimized;
  if (typeof patch.unloadWindowInTray === 'boolean') safe.unloadWindowInTray = patch.unloadWindowInTray;
  if (typeof patch.ecoMode === 'boolean') safe.ecoMode = patch.ecoMode;
  if (typeof patch.disableGpu === 'boolean') safe.disableGpu = patch.disableGpu;
  if (typeof patch.watchdog === 'boolean') safe.watchdog = patch.watchdog;
  if (typeof patch.toggleHotkey === 'boolean') safe.toggleHotkey = patch.toggleHotkey;
  if (typeof patch.testMode === 'string') safe.testMode = patch.testMode;
  if (['disabled', 'all', 'tcp', 'udp'].includes(patch.gameFilterMode)) safe.gameFilterMode = patch.gameFilterMode;
  if (Number.isFinite(Number(patch.ambientIntensity))) safe.ambientIntensity = clampNumber(patch.ambientIntensity, 0, 100);
  if (Number.isFinite(Number(patch.glassBlur))) safe.glassBlur = clampNumber(patch.glassBlur, 0, 32);
  if (Number.isFinite(Number(patch.motionSpeed))) safe.motionSpeed = clampNumber(patch.motionSpeed, 0, 100);
  return safe;
}

function sanitizeCustomTheme(theme) {
  const result = { ...defaultSettings.customTheme };
  for (const key of ['accent', 'accent2', 'accent3', 'bg']) {
    const value = theme[key];
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())) {
      result[key] = value.trim().toLowerCase();
    }
  }
  return result;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function syncLoginItem() {
  if (process.platform !== 'win32') return;

  const args = ['--startup'];
  if (process.defaultApp) {
    args.unshift(path.resolve(__dirname, '..'));
  }

  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.launchAtLogin),
    path: process.execPath,
    args
  });
}

function ensureZapretFiles() {
  if (!fs.existsSync(winwsExe)) {
    log(`winws.exe не найден: ${winwsExe}`, 'error');
  }
  fs.mkdirSync(listsDir, { recursive: true });
  fs.mkdirSync(utilsDir, { recursive: true });
  ensureRequiredLists();
}

function ensureUserLists() {
  const defaults = {
    'list-general-user.txt': 'domain.example.abc\r\n',
    'list-exclude-user.txt': 'domain.example.abc\r\n',
    'ipset-exclude-user.txt': '203.0.113.113/32\r\n'
  };

  for (const [name, content] of Object.entries(defaults)) {
    const file = path.join(listsDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8');
  }
}

function resolveListsSeedDir() {
  const candidates = [
    path.join(process.resourcesPath, 'zapret-seed', 'lists'),
    path.join(__dirname, '..', 'zapret', 'lists')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function ensureRequiredLists() {
  ensureUserLists();
  fs.mkdirSync(listsDir, { recursive: true });

  const seedDir = resolveListsSeedDir();
  if (seedDir) {
    for (const entry of fs.readdirSync(seedDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.txt$/i.test(entry.name) || /-user\.txt$/i.test(entry.name)) continue;
      const target = path.join(listsDir, entry.name);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(seedDir, entry.name), target);
        log(`Добавлен отсутствующий список: ${entry.name}`);
      }
    }
  }

  const fallbacks = {
    'ipset-exclude.txt': [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '127.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
      '224.0.0.0/4',
      '100.64.0.0/10',
      '::1',
      'fc00::/7',
      'fe80::/10'
    ].join('\r\n') + '\r\n',
    'list-exclude.txt': 'domain.example.abc\r\n',
    'list-general.txt': 'cloudflare-ech.com\r\n',
    'list-google.txt': 'youtube.com\r\n',
    'ipset-all.txt': '203.0.113.113/32\r\n'
  };

  for (const [name, content] of Object.entries(fallbacks)) {
    const file = path.join(listsDir, name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, content, 'utf8');
      log(`Создан базовый список: ${name}`);
    }
  }
}

function invalidateRuntimeStatus() {
  runtimeStatus.refreshedAt = 0;
}

function invalidateServiceCache() {
  cachedServiceConfigName = undefined;
}

async function refreshRuntimeStatus(force = false) {
  const now = Date.now();
  if (!force && runtimeStatus.refreshedAt && now - runtimeStatus.refreshedAt < RUNTIME_STATUS_TTL_MS) {
    return runtimeStatus;
  }
  if (runtimeStatusPromise) return runtimeStatusPromise;

  runtimeStatusPromise = (async () => {
    const [running, service] = await Promise.all([getWinwsStatus(), getServiceStatus()]);
    runtimeStatus = { running: annotateRunning(running, service), service, refreshedAt: Date.now() };
    return runtimeStatus;
  })().finally(() => {
    runtimeStatusPromise = null;
  });

  return runtimeStatusPromise;
}

function annotateRunning(running, service) {
  // Процессы, поднятые нашей службой, тоже считаем своими, а не «внешними».
  if (!service?.installed || service.state !== 'RUNNING' || !running.processes.length) return running;

  const processes = running.processes.map((processInfo) => ({
    ...processInfo,
    managed: true,
    source: processInfo.managed ? 'zapret' : 'service'
  }));

  return { ...running, processes, managedCount: processes.length, externalCount: 0 };
}

async function buildState() {
  if (buildStatePromise) return buildStatePromise;

  buildStatePromise = buildStateInner().finally(() => {
    buildStatePromise = null;
  });

  return buildStatePromise;
}

async function buildStateInner() {
  const [{ running, service }, admin] = await Promise.all([
    refreshRuntimeStatus(),
    resolveAdminStatus()
  ]);

  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    rootDir,
    winwsExe,
    settings,
    configs: getConfigs(),
    running,
    admin,
    service,
    versions: {
      local: readLocalVersion(),
      latest: lastUpdate.latestVersion
    },
    update: lastUpdate,
    appUpdate: lastAppUpdate,
    hotkey: { combo: TOGGLE_HOTKEY.replace('Control', 'Ctrl'), active: hotkeyRegistered },
    logs: recentLogs.slice(-160)
  };
}

async function resolveAdminStatus() {
  if (cachedAdmin !== null) return cachedAdmin;
  cachedAdmin = await isAdministrator();
  return cachedAdmin;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function sendState(options = {}) {
  const { refresh = true } = options;
  if (refresh) invalidateRuntimeStatus();

  // Пока окно скрыто или выгружено, полный state не нужен — обновляем только трей.
  if (!isWindowVisible()) {
    await refreshRuntimeStatus();
    updateTray();
    return;
  }

  const state = await buildState();
  updateTray();
  send('state:update', state);
}

function log(message, type = 'info') {
  const entry = {
    time: new Date().toISOString(),
    type,
    message: String(message)
  };
  recentLogs.push(entry);
  if (recentLogs.length > RECENT_LOGS_LIMIT) recentLogs = recentLogs.slice(-RECENT_LOGS_LIMIT);

  appendLogFile(`[${entry.time}] [${type.toUpperCase()}] ${entry.message}${os.EOL}`);
  send('log:new', entry);
}

function appendLogFile(line) {
  if (!logFile) return;

  try {
    if (logFileBytes === null) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logFileBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    }

    if (logFileBytes > LOG_MAX_BYTES) {
      fs.rmSync(`${logFile}.1`, { force: true });
      fs.renameSync(logFile, `${logFile}.1`);
      logFileBytes = 0;
    }

    logFileBytes += Buffer.byteLength(line, 'utf8');
    fs.appendFile(logFile, line, () => {});
  } catch {
    logFileBytes = 0;
  }
}

function readLogFile() {
  // Читаем только хвост файла: полный лог может весить мегабайты.
  let handle = null;
  try {
    const size = fs.statSync(logFile).size;
    if (size <= LOG_TAIL_BYTES) return fs.readFileSync(logFile, 'utf8');

    const buffer = Buffer.alloc(LOG_TAIL_BYTES);
    handle = fs.openSync(logFile, 'r');
    fs.readSync(handle, buffer, 0, LOG_TAIL_BYTES, size - LOG_TAIL_BYTES);
    const text = buffer.toString('utf8');
    return `... (показан последний фрагмент лога)\n${text.slice(text.indexOf('\n') + 1)}`;
  } catch {
    return '';
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

function collectMetrics() {
  const totals = { main: 0, renderer: 0, other: 0, total: 0 };

  try {
    for (const metric of app.getAppMetrics()) {
      const mb = (metric.memory?.workingSetSize || 0) / 1024;
      totals.total += mb;
      if (metric.type === 'Browser') totals.main += mb;
      else if (metric.type === 'Tab' || metric.type === 'Renderer') totals.renderer += mb;
      else totals.other += mb;
    }
  } catch {}

  return {
    mainMb: Math.round(totals.main),
    rendererMb: Math.round(totals.renderer),
    otherMb: Math.round(totals.other),
    totalMb: Math.round(totals.total),
    windowLoaded: hasWindow(),
    pollIntervalMs
  };
}

function getConfigs() {
  // Список .bat меняется только при обновлении zapret — читать каталог на каждый тик незачем.
  if (configsCache && Date.now() - configsCache.at < CONFIGS_TTL_MS) return configsCache.items;

  const items = readConfigsFromDisk();
  configsCache = { at: Date.now(), items };
  return items;
}

function readConfigsFromDisk() {
  try {
    return fs.readdirSync(rootDir)
      .filter((name) => /^general.*\.bat$/i.test(name))
      .sort(naturalSort)
      .map((name) => ({
        name,
        label: name.replace(/\.bat$/i, ''),
        path: path.join(rootDir, name),
        kind: getConfigKind(name)
      }));
  } catch {
    return [];
  }
}

function getConfigKind(name) {
  const upper = name.toUpperCase();
  if (upper.includes('FAKE TLS AUTO')) return 'Fake TLS Auto';
  if (upper.includes('SIMPLE FAKE')) return 'Simple Fake';
  if (upper.includes('ALT')) return 'ALT';
  return 'Default';
}

function naturalSort(a, b) {
  return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
}

function readLocalVersion() {
  try {
    const service = fs.readFileSync(path.join(rootDir, 'service.bat'), 'utf8');
    const match = service.match(/set\s+"LOCAL_VERSION=([^"]+)"/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function readGameFilterMode(fallback = 'disabled') {
  const flag = path.join(utilsDir, 'game_filter.enabled');
  if (!fs.existsSync(flag)) return 'disabled';

  const mode = fs.readFileSync(flag, 'utf8').trim().toLowerCase();
  return ['all', 'tcp', 'udp'].includes(mode) ? mode : fallback;
}

function setGameFilterMode(mode) {
  const flag = path.join(utilsDir, 'game_filter.enabled');
  if (mode === 'disabled') {
    fs.rmSync(flag, { force: true });
  } else {
    fs.writeFileSync(flag, `${mode}\r\n`, 'utf8');
  }
  log(`Игровой фильтр: ${mode}`);
}

function getGameFilterValues() {
  const mode = readGameFilterMode(settings?.gameFilterMode || 'disabled');
  if (mode === 'all') return { game: '1024-65535', tcp: '1024-65535', udp: '1024-65535' };
  if (mode === 'tcp') return { game: '1024-65535', tcp: '1024-65535', udp: '12' };
  if (mode === 'udp') return { game: '1024-65535', tcp: '12', udp: '1024-65535' };
  return { game: '12', tcp: '12', udp: '12' };
}

function parseConfig(configName) {
  const safeName = path.basename(configName || settings.selectedConfig);
  const configPath = path.join(rootDir, safeName);
  if (!fs.existsSync(configPath)) throw new Error(`Конфиг не найден: ${safeName}`);

  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /winws\.exe/i.test(line));
  if (startIndex === -1) throw new Error(`В ${safeName} не найден запуск winws.exe`);

  let joined = '';
  for (let index = startIndex; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line) continue;
    const continues = /\^\s*$/.test(line);
    line = line.replace(/\^\s*$/, '');
    joined += ` ${line}`;
    if (!continues) break;
  }

  const lower = joined.toLowerCase();
  const exeIndex = lower.indexOf('winws.exe');
  let argText = joined.slice(exeIndex + 'winws.exe'.length).trim();
  if (argText.startsWith('"')) argText = argText.slice(1).trim();
  argText = expandBatchVariables(argText);
  const args = splitArgs(argText).filter(Boolean);

  return {
    name: safeName,
    file: configPath,
    exe: winwsExe,
    args,
    commandLine: `${quoteCommandArg(winwsExe)} ${args.map(quoteCommandArg).join(' ')}`
  };
}

function expandBatchVariables(input) {
  const game = getGameFilterValues();
  const replacements = {
    '%BIN%': ensureTrailingSlash(binDir),
    '%LISTS%': ensureTrailingSlash(listsDir),
    '%~dp0': ensureTrailingSlash(rootDir),
    '%GameFilter%': game.game,
    '%GameFilterTCP%': game.tcp,
    '%GameFilterUDP%': game.udp
  };

  let output = input.replace(/\^!/g, '!').replace(/\^"/g, '"');
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replace(new RegExp(escapeRegExp(key), 'gi'), value);
  }
  return output;
}

function splitArgs(input) {
  const args = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (/\s/.test(char) && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

async function startZapret(configName, options = {}) {
  if (startZapretInFlight) return startZapretInFlight;

  startZapretInFlight = startZapretInner(configName, options).finally(() => {
    startZapretInFlight = null;
  });

  return startZapretInFlight;
}

async function startZapretInner(configName, options = {}) {
  const config = parseConfig(configName || settings.selectedConfig);
  ensureRequiredLists();

  const service = await getServiceStatus();
  if (service.installed && options.useService !== false) {
    if (service.configName && service.configName !== config.name) {
      await installZapretService(config.name);
      await sendState();
      return config;
    }

    if (service.state === 'RUNNING') {
      const running = await getWinwsStatus();
      if (running.active) {
        log(`Служба zapret уже работает: ${config.name}`);
        if (options.remember !== false) {
          settings.selectedConfig = config.name;
          saveSettings();
        }
        await sendState();
        return config;
      }
    }

    await stopZapretProcesses({ stopService: true, quiet: true, killProcesses: false });
    log(`Запуск службы zapret: ${config.name}`);
    await execFileAsync('sc.exe', ['start', SERVICE_NAME], { timeout: 10000 });

    if (options.remember !== false) {
      settings.selectedConfig = config.name;
      saveSettings();
    }

    await delay(1200);
    const running = await getWinwsStatus();
    if (!running.active) {
      throw new Error('Служба запущена, но winws.exe не работает. Проверьте списки в zapret/lists и попробуйте другой конфиг.');
    }

    await sendState();
    return config;
  }

  if (!await isAdministrator()) {
    throw new Error('First setup needs administrator rights. Open Settings, click Install in Windows Service, and approve UAC once.');
  }

  await stopZapretProcesses({ stopService: true, quiet: true });
  await enableTcpTimestamps();

  log(`Запуск zapret: ${config.name}`);
  winwsChild = spawn(config.exe, config.args, {
    cwd: binDir,
    windowsHide: true,
    env: { ...process.env, NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (options.remember !== false) {
    settings.selectedConfig = config.name;
    saveSettings();
  }

  winwsChild.stdout?.on('data', (chunk) => {
    splitLines(chunk).forEach((line) => log(`[winws] ${line}`));
  });
  winwsChild.stderr?.on('data', (chunk) => {
    splitLines(chunk).forEach((line) => log(`[winws] ${line}`, 'warn'));
  });
  winwsChild.on('error', (error) => {
    log(`winws.exe не стартовал: ${error.message}`, 'error');
  });
  winwsChild.on('exit', (code, signal) => {
    const child = winwsChild;
    log(`winws.exe остановлен: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    winwsChild = null;
    child?.stdout?.removeAllListeners();
    child?.stderr?.removeAllListeners();

    if (!intentionalStop && !isQuitting && settings.watchdog) {
      triggerWatchdogRestart(`winws.exe завершился (code=${code ?? 'null'})`);
    }
    sendState().catch(() => {});
  });

  lastActiveConfig = config.name;
  await delay(500);
  await sendState();
  return config;
}

async function stopZapretProcesses(options = {}) {
  const { stopService = true, quiet = false, killProcesses = true } = options;

  intentionalStop = true;
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  try {
    if (winwsChild && !winwsChild.killed) {
      try {
        winwsChild.kill('SIGTERM');
      } catch {}
    }
    winwsChild = null;

    if (stopService) {
      await execFileQuiet('sc.exe', ['stop', SERVICE_NAME], 6000);
    }

    if (killProcesses) {
      // taskkill вместо powershell: тот же результат за доли памяти и времени.
      await execFileQuiet('taskkill.exe', ['/IM', 'winws.exe', '/F'], 8000);
    }

    if (!quiet) log('zapret остановлен');
    await sendState();
  } finally {
    setTimeout(() => {
      intentionalStop = false;
    }, 3000).unref?.();
  }
}

async function enableTcpTimestamps() {
  await execFileQuiet('netsh.exe', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], 7000);
}

async function getWinwsStatus() {
  // tasklist.exe стоит ~2 МБ и миллисекунды CPU, powershell.exe — десятки мегабайт на каждый опрос.
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq winws.exe', '/NH', '/FO', 'CSV'], {
      timeout: 5000,
      maxBuffer: 256 * 1024
    });
    const processes = parseTasklistCsv(stdout).map(normalizeWinwsProcess);
    const managedCount = processes.filter((processInfo) => processInfo.managed).length;
    return {
      active: processes.length > 0,
      processes,
      managedCount,
      externalCount: processes.length - managedCount,
      memoryKb: processes.reduce((sum, item) => sum + (item.MemoryKb || 0), 0)
    };
  } catch {
    const alive = Boolean(winwsChild && !winwsChild.killed);
    return {
      active: alive,
      processes: alive ? [{ ProcessId: winwsChild.pid, managed: true, source: 'zapret' }] : [],
      managedCount: alive ? 1 : 0,
      externalCount: 0,
      memoryKb: 0
    };
  }
}

function parseTasklistCsv(stdout) {
  const rows = [];

  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^"winws\.exe"/i.test(trimmed)) continue;

    const cells = trimmed.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
    const pid = Number(cells[1]);
    if (!Number.isFinite(pid)) continue;

    rows.push({
      ProcessId: pid,
      SessionName: cells[2] || '',
      MemoryKb: Number(String(cells[4] || '').replace(/[^\d]/g, '')) || 0
    });
  }

  return rows;
}

function normalizeWinwsProcess(processInfo) {
  const managed = Boolean(winwsChild && !winwsChild.killed && winwsChild.pid === processInfo.ProcessId);

  return {
    ...processInfo,
    managed,
    source: managed ? 'zapret' : 'external'
  };
}

async function isAdministrator() {
  if (process.platform !== 'win32') return true;
  try {
    await execFileAsync('net.exe', ['session'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function getServiceStatus() {
  try {
    const { stdout } = await execFileAsync('sc.exe', ['query', SERVICE_NAME], { timeout: 5000 });
    const state = parseServiceState(stdout);
    const configName = await readServiceConfigName();
    return { installed: true, state, configName };
  } catch {
    return { installed: false, state: 'NOT_INSTALLED', configName: null };
  }
}

function parseServiceState(stdout) {
  const text = String(stdout || '');
  const states = [
    'RUNNING',
    'STOPPED',
    'START_PENDING',
    'STOP_PENDING',
    'PAUSE_PENDING',
    'PAUSED',
    'CONTINUE_PENDING'
  ];

  for (const state of states) {
    if (new RegExp(`\\b${state}\\b`, 'i').test(text)) return state;
  }

  const numeric = text.match(/:\s*(\d+)\s+([A-Z_]+)/i);
  if (numeric?.[2]) return numeric[2].toUpperCase();

  return 'UNKNOWN';
}

async function readServiceConfigName() {
  if (cachedServiceConfigName !== undefined) return cachedServiceConfigName;

  try {
    const { stdout } = await execFileAsync('reg.exe', [
      'query',
      `HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}`,
      '/v',
      'zapret-discord-youtube'
    ], { timeout: 5000 });
    const raw = stdout.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    if (!raw) {
      cachedServiceConfigName = null;
      return null;
    }
    cachedServiceConfigName = /\.bat$/i.test(raw) ? raw : `${raw}.bat`;
    return cachedServiceConfigName;
  } catch {
    cachedServiceConfigName = null;
    return null;
  }
}

async function relaunchAsAdmin(options = {}) {
  if (process.platform !== 'win32') return false;

  const exe = process.execPath;
  const currentArgs = process.argv.slice(1).filter((arg) => arg !== '--elevated-attempted');
  const args = process.defaultApp ? [path.resolve(__dirname, '..'), ...currentArgs.slice(1)] : currentArgs;
  if (options.elevatedAttempt && !args.includes('--elevated-attempted')) {
    args.push('--elevated-attempted');
  }
  const argList = args.map((arg) => quotePowerShellSingle(arg)).join(', ');
  const command = `Start-Process -FilePath ${quotePowerShellSingle(exe)} -ArgumentList @(${argList}) -Verb RunAs`;

  if (options.releaseLock) {
    releaseSingleInstanceLock();
  }

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 45000 });
    return true;
  } catch (error) {
    if (options.releaseLock) {
      reacquireSingleInstanceLock();
    }
    log(`Не удалось запустить админ-режим: ${error.message}`, 'error');
    return false;
  }
}

function releaseSingleInstanceLock() {
  if (!useSingleInstanceLock) return;
  if (!ownsSingleInstanceLock) return;
  try {
    app.releaseSingleInstanceLock();
    ownsSingleInstanceLock = false;
  } catch {}
}

function reacquireSingleInstanceLock() {
  if (!useSingleInstanceLock) return true;
  if (ownsSingleInstanceLock) return true;
  try {
    ownsSingleInstanceLock = app.requestSingleInstanceLock();
  } catch {
    ownsSingleInstanceLock = false;
  }
  return ownsSingleInstanceLock;
}

function readGeneralList() {
  ensureRequiredLists();
  const base = readDomainFile(path.join(listsDir, 'list-general.txt'));
  const user = readDomainFile(path.join(listsDir, 'list-general-user.txt'));
  return { base, user };
}

function readDomainFile(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line !== 'domain.example.abc');
  } catch {
    return [];
  }
}

function normalizeDomain(domain) {
  let value = String(domain || '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  value = value.replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9*.-]+\.[a-z0-9.-]+$/i.test(value)) {
    throw new Error('Неверный домен');
  }
  return value;
}

function addGeneralDomain(domain) {
  ensureRequiredLists();
  const normalized = normalizeDomain(domain);
  const list = readGeneralList().user;
  if (!list.includes(normalized)) list.push(normalized);
  saveGeneralDomains(list);
  log(`Добавлен домен: ${normalized}`);
  return readGeneralList();
}

function removeGeneralDomain(domain) {
  const normalized = normalizeDomain(domain);
  const list = readGeneralList().user.filter((item) => item !== normalized);
  saveGeneralDomains(list);
  log(`Удалён домен: ${normalized}`);
  return readGeneralList();
}

function saveGeneralDomains(domains) {
  const normalized = Array.from(new Set((domains || []).map(normalizeDomain))).sort(naturalSort);
  fs.writeFileSync(path.join(listsDir, 'list-general-user.txt'), `${normalized.join('\r\n')}\r\n`, 'utf8');
  return readGeneralList();
}

async function checkForZapretUpdate(options = {}) {
  lastUpdate = {
    ...lastUpdate,
    status: 'checking',
    localVersion: readLocalVersion(),
    message: 'Проверяю GitHub'
  };
  send('update:progress', lastUpdate);
  log('Проверка обновления zapret');

  const latestVersion = (await fetchText(VERSION_URL)).trim();
  const localVersion = readLocalVersion();
  const hasUpdate = compareVersions(localVersion, latestVersion) < 0;

  lastUpdate = {
    status: hasUpdate ? 'available' : 'current',
    localVersion,
    latestVersion,
    message: hasUpdate ? `Доступна версия ${latestVersion}` : `Установлена актуальная версия ${localVersion}`
  };
  send('update:progress', lastUpdate);
  log(lastUpdate.message);

  if (hasUpdate && options.apply) {
    await applyZapretUpdate(latestVersion);
  }

  await sendState();
  return lastUpdate;
}

async function fetchLatestAppVersion() {
  const errors = [];

  for (const attempt of [1, 2]) {
    try {
      return (await fetchText(`${APP_VERSION_URL}?t=${Date.now()}`)).trim();
    } catch (error) {
      errors.push(`raw: ${error.message}`);
      await delay(800);
    }
  }

  try {
    const release = await fetchJson(APP_RELEASE_API_URL);
    return String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
  } catch (error) {
    errors.push(`api: ${error.message}`);
  }

  throw new Error(errors.join('; ') || 'Не удалось получить версию приложения');
}

function buildAppInstallerUrl(version) {
  const safeVersion = String(version).replace(/^v/i, '');
  const fileName = `Zapret-Control-Center-Setup-${safeVersion}.exe`;
  return {
    fileName,
    url: `https://github.com/${APP_REPO}/releases/download/v${safeVersion}/${fileName}`
  };
}

async function downloadAppUpdate(version) {
  const { fileName, url } = buildAppInstallerUrl(version);
  const target = path.join(app.getPath('temp'), fileName);

  lastAppUpdate = {
    status: 'downloading',
    version,
    message: 'Скачиваю обновление 0%',
    progress: 0
  };
  sendAppUpdateProgress();

  await downloadFile(url, target, 0, (loaded, total) => {
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : 0;
    lastAppUpdate = {
      ...lastAppUpdate,
      status: 'downloading',
      message: `Скачиваю обновление ${percent}%`,
      progress: percent
    };
    sendAppUpdateProgress();
  });

  pendingAppInstallerPath = target;
  lastAppUpdate = {
    status: 'downloaded',
    version,
    message: `Обновление ${version} готово к установке`,
    progress: 100
  };
  sendAppUpdateProgress();
  pushNotification({
    type: 'success',
    title: 'Обновление готово',
    message: `Версия ${version} скачана. Нажмите «Установить», чтобы обновить приложение.`,
    persistent: true,
    action: 'app-update'
  });
  log(`Обновление приложения скачано: ${version}`);
}

async function checkForAppUpdate() {
  if (!app.isPackaged) {
    lastAppUpdate = {
      status: 'dev',
      version: app.getVersion(),
      message: 'Автообновление приложения доступно только в установленной версии',
      progress: 0
    };
    sendAppUpdateProgress();
    return lastAppUpdate;
  }

  lastAppUpdate = {
    status: 'checking',
    version: lastAppUpdate.version,
    message: 'Проверяю обновления приложения...',
    progress: 0
  };
  sendAppUpdateProgress();

  try {
    const localVersion = app.getVersion();
    const latestVersion = await fetchLatestAppVersion();

    if (compareVersions(localVersion, latestVersion) >= 0) {
      lastAppUpdate = {
        status: 'up-to-date',
        version: localVersion,
        message: `Приложение актуально (${localVersion})`,
        progress: 0
      };
      sendAppUpdateProgress();
      return lastAppUpdate;
    }

    if (lastAppUpdate.status === 'downloaded'
      && lastAppUpdate.version === latestVersion
      && pendingAppInstallerPath
      && fs.existsSync(pendingAppInstallerPath)) {
      sendAppUpdateProgress();
      return lastAppUpdate;
    }

    lastAppUpdate = {
      status: 'available',
      version: latestVersion,
      message: `Доступно обновление приложения ${latestVersion}`,
      progress: 0
    };
    sendAppUpdateProgress();
    pushNotification({
      type: 'info',
      title: 'Доступно обновление',
      message: `Версия ${latestVersion} скачивается автоматически.`,
      persistent: true,
      action: 'app-update'
    });
    log(`Доступно обновление приложения: ${latestVersion}`);

    await downloadAppUpdate(latestVersion);
    return lastAppUpdate;
  } catch (error) {
    lastAppUpdate = {
      status: 'error',
      version: lastAppUpdate.version,
      message: error.message || 'Ошибка проверки обновлений приложения',
      progress: 0
    };
    sendAppUpdateProgress();
    log(`Ошибка автообновления приложения: ${lastAppUpdate.message}`, 'error');
    throw error;
  }
}

function sendAppUpdateProgress() {
  send('app-update:progress', lastAppUpdate);
  sendState().catch(() => {});
}

function pushNotification(payload) {
  send('notification:push', payload);
}

async function applyZapretUpdate(latestVersion) {
  lastUpdate = {
    ...lastUpdate,
    status: 'downloading',
    message: 'Скачиваю релиз'
  };
  send('update:progress', lastUpdate);

  const release = await fetchJson(RELEASE_API_URL);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) => /\.zip$/i.test(item.name) && /zapret|discord|youtube/i.test(item.name))
    || assets.find((item) => /\.zip$/i.test(item.name));

  if (!asset?.browser_download_url) {
    throw new Error('В последнем релизе не найден zip-архив');
  }

  const wasRunning = (await getWinwsStatus()).active;
  if (wasRunning) await stopZapretProcesses({ stopService: true, quiet: true });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-update-'));
  const zipPath = path.join(tempRoot, asset.name);
  const extractDir = path.join(tempRoot, 'extract');

  try {
    await downloadFile(asset.browser_download_url, zipPath);

    lastUpdate = { ...lastUpdate, status: 'installing', message: 'Распаковываю и применяю обновление' };
    send('update:progress', lastUpdate);

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath ${quotePowerShellSingle(zipPath)} -DestinationPath ${quotePowerShellSingle(extractDir)} -Force`
    ], { timeout: 120000 });

    const extractedRoot = findExtractedZapretRoot(extractDir);
    if (!extractedRoot) throw new Error('В архиве не найден service.bat');

    backupZapretFiles();
    applyUpdateFiles(extractedRoot);
    ensureRequiredLists();
    configsCache = null;
    trayMenuSignature = null;
  } finally {
    // Архив и распакованные файлы иначе навсегда остаются в %TEMP%.
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }

  pruneOldBackups();

  lastUpdate = {
    status: 'updated',
    localVersion: readLocalVersion(),
    latestVersion,
    message: `zapret обновлён до ${latestVersion}`
  };
  send('update:progress', lastUpdate);
  log(lastUpdate.message);

  if (wasRunning && settings.autoStartZapret) {
    await startZapret(settings.bestConfig || settings.selectedConfig, { remember: false, reason: 'update' });
  }
}

function findExtractedZapretRoot(startDir) {
  const stack = [startDir];
  while (stack.length) {
    const current = stack.pop();
    if (fs.existsSync(path.join(current, 'service.bat'))) return current;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return null;
}

function backupZapretFiles() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(rootDir, '.zapret-backups', stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const name of fs.readdirSync(rootDir)) {
    if (/^general.*\.bat$/i.test(name) || name === 'service.bat') {
      fs.copyFileSync(path.join(rootDir, name), path.join(backupDir, name));
    }
  }

  for (const dir of ['bin', 'lists', 'utils']) {
    const source = path.join(rootDir, dir);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backupDir, dir), { recursive: true });
  }

  log(`Резервная копия zapret: ${backupDir}`);
}

function pruneOldBackups(keep = 3) {
  // Каждая копия — это полный bin/lists/utils, за десяток обновлений набегают сотни мегабайт.
  try {
    const root = path.join(rootDir, '.zapret-backups');
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      log(`Удалена старая резервная копия: ${name}`);
    }
  } catch {}
}

function applyUpdateFiles(sourceRoot) {
  for (const name of fs.readdirSync(sourceRoot)) {
    if (/^general.*\.bat$/i.test(name) || name === 'service.bat') {
      fs.copyFileSync(path.join(sourceRoot, name), path.join(rootDir, name));
    }
  }

  copyDirFiltered(path.join(sourceRoot, 'bin'), binDir);
  mergeListsDirectory(path.join(sourceRoot, 'lists'), listsDir);
  copyDirFiltered(path.join(sourceRoot, 'utils'), utilsDir, (name) => !/\.enabled$/i.test(name));
}

function mergeListsDirectory(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });

  let addedTotal = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (/-user\.txt$/i.test(entry.name)) continue;

    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);

    if (entry.isDirectory()) {
      mergeListsDirectory(from, to);
      continue;
    }

    if (/^ipset-all\.txt$/i.test(entry.name) && isIpsetSpecialMode(to)) {
      continue;
    }

    if (isMergeableListFile(entry.name)) {
      addedTotal += mergeListFile(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }

  if (addedTotal > 0) {
    log(`Списки zapret обновлены без очистки: добавлено строк ${addedTotal}`);
  }
}

function isMergeableListFile(name) {
  return /\.(txt|lst|backup)$/i.test(name);
}

function isIpsetSpecialMode(file) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  return lines.length === 0 || (lines.length === 1 && lines[0] === '203.0.113.113/32');
}

function mergeListFile(source, target) {
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
    return countMeaningfulLines(fs.readFileSync(source, 'utf8'));
  }

  const targetText = fs.readFileSync(target, 'utf8');
  const sourceLines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
  const existingLines = targetText.split(/\r?\n/);
  const existingKeys = new Set(existingLines.map(getListLineKey).filter(Boolean));
  const additions = [];

  for (const line of sourceLines) {
    const key = getListLineKey(line);
    if (!key || existingKeys.has(key)) continue;
    existingKeys.add(key);
    additions.push(line.trim());
  }

  if (additions.length === 0) return 0;

  const separator = targetText.endsWith('\n') || targetText.length === 0 ? '' : '\r\n';
  fs.writeFileSync(target, `${targetText}${separator}${additions.join('\r\n')}\r\n`, 'utf8');
  return additions.length;
}

function getListLineKey(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function countMeaningfulLines(text) {
  return text.split(/\r?\n/).map(getListLineKey).filter(Boolean).length;
}

function copyDirFiltered(source, target, filter = () => true) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(from, to, filter);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

async function runConfigTests(options) {
  activeTest = { cancelled: false };
  cancelWindowUnload();
  scheduleStatusPoll(true);
  const mode = options.mode || settings.testMode || 'fast';
  const applyBest = options.applyBest !== false;
  const configs = getConfigs();
  const targets = readTargets(mode);
  const previousConfig = settings.selectedConfig;
  const wasRunning = (await getWinwsStatus()).active;
  const results = [];

  log(`Старт тестов: ${configs.length} конфигов, режим ${mode}`);
  send('tests:start', { total: configs.length, mode, targets: targets.length });

  try {
    for (let index = 0; index < configs.length; index += 1) {
      if (activeTest.cancelled) break;
      const config = configs[index];
      send('tests:progress', { index, total: configs.length, config: config.name, stage: 'start' });
      await startZapret(config.name, { remember: false, reason: 'test', useService: false });
      await delay(4200);
      const targetResults = await testTargets(targets, (target, targetIndex) => {
        send('tests:target', { config: config.name, target: target.name, targetIndex, totalTargets: targets.length });
      });
      const score = scoreTargets(targetResults);
      results.push({ config: config.name, score, targetResults });
      send('tests:result', { config: config.name, score, targetResults });
      await stopZapretProcesses({ stopService: false, quiet: true });
    }

    const best = results.slice().sort((a, b) => b.score.total - a.score.total || b.score.ok - a.score.ok || a.score.fail - b.score.fail)[0];
    if (best) {
      settings.bestConfig = best.config;
      settings.selectedConfig = best.config;
      saveSettings();
      log(`Лучший конфиг: ${best.config} (${best.score.total} баллов)`);
      send('tests:done', { best, results, cancelled: activeTest.cancelled });
      if (applyBest && !activeTest.cancelled) {
        await startZapret(best.config, { remember: true, reason: 'best-test', useService: false });
      }
    } else {
      send('tests:done', { best: null, results, cancelled: activeTest.cancelled });
    }
  } finally {
    const cancelled = activeTest?.cancelled;
    activeTest = null;
    scheduleStatusPoll(true);
    if (cancelled) {
      log('Тесты остановлены пользователем', 'warn');
      if (wasRunning) await startZapret(previousConfig, { remember: false, reason: 'restore', useService: false });
    }
    await sendState();
  }
}

function readTargets(mode) {
  const file = path.join(utilsDir, 'targets.txt');
  const fallback = [
    { name: 'Discord', value: 'https://discord.com' },
    { name: 'DiscordCDN', value: 'https://cdn.discordapp.com' },
    { name: 'YouTube', value: 'https://www.youtube.com' },
    { name: 'Google', value: 'https://www.google.com' },
    { name: 'CloudflareDNS', value: 'PING:1.1.1.1' }
  ];

  let targets = [];
  try {
    targets = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]+)"\s*$/))
      .filter(Boolean)
      .map((match) => ({ name: match[1], value: match[2] }));
  } catch {
    targets = fallback;
  }

  if (!targets.length) targets = fallback;
  if (mode === 'full') return targets.map(convertTarget);

  const preferred = new Set(['DiscordMain', 'DiscordCDN', 'YouTubeWeb', 'GoogleMain', 'CloudflareDNS1111']);
  const fast = targets.filter((target) => preferred.has(target.name));
  return (fast.length ? fast : fallback).map(convertTarget);
}

function convertTarget(target) {
  if (target.value.toUpperCase().startsWith('PING:')) {
    return {
      name: target.name,
      url: null,
      ping: target.value.replace(/^PING:\s*/i, '')
    };
  }
  return {
    name: target.name,
    url: target.value,
    ping: target.value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  };
}

async function testTargets(targets, onTarget) {
  const results = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (activeTest?.cancelled) break;
    const target = targets[index];
    onTarget?.(target, index);
    const checks = [];
    if (target.url) {
      checks.push(await runCurlCheck(target.url, 'HTTP', ['--http1.1']));
      checks.push(await runCurlCheck(target.url, 'TLS1.2', ['--tlsv1.2', '--tls-max', '1.2']));
      checks.push(await runCurlCheck(target.url, 'TLS1.3', ['--tlsv1.3', '--tls-max', '1.3']));
    }
    const ping = target.ping ? await runPingCheck(target.ping) : null;
    results.push({ name: target.name, url: target.url, pingTarget: target.ping, checks, ping });
  }
  return results;
}

async function runCurlCheck(url, label, protocolArgs) {
  try {
    const args = ['-I', '-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', '--show-error', ...protocolArgs, url];
    const { stdout } = await execFileAsync('curl.exe', args, { timeout: 7000 });
    const code = stdout.trim();
    return { label, ok: /^\d{3}$/.test(code), code };
  } catch (error) {
    const text = `${error.stdout || ''} ${error.stderr || ''} ${error.message}`;
    const unsupported = /not supported|unsupported|unknown option|unrecognized option|schannel/i.test(text);
    return { label, ok: false, unsupported, code: unsupported ? 'UNSUP' : 'ERR' };
  }
}

async function runPingCheck(host) {
  try {
    const { stdout } = await execFileAsync('ping.exe', ['-n', '2', '-w', '1200', host], { timeout: 5000 });
    const lostMatch = stdout.match(/\((\d+)%\s*loss\)/i) || stdout.match(/потеряно\s*=\s*(\d+)/i);
    const ok = lostMatch ? Number(lostMatch[1]) < 100 : /TTL=|TTL=/i.test(stdout);
    const avgMatch = stdout.match(/Average\s*=\s*(\d+)ms/i) || stdout.match(/Среднее\s*=\s*(\d+)\s*мсек/i);
    return { ok, ms: avgMatch ? Number(avgMatch[1]) : null };
  } catch {
    return { ok: false, ms: null };
  }
}

function scoreTargets(targetResults) {
  let ok = 0;
  let fail = 0;
  let unsupported = 0;
  let pingOk = 0;

  for (const target of targetResults) {
    for (const check of target.checks) {
      if (check.ok) ok += 1;
      else if (check.unsupported) unsupported += 1;
      else fail += 1;
    }
    if (target.ping?.ok) pingOk += 1;
    else if (target.ping) fail += 1;
  }

  return {
    ok,
    fail,
    unsupported,
    pingOk,
    total: ok * 3 + pingOk - fail
  };
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      windowsHide: true,
      timeout: options.timeout || 15000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function execFileQuiet(command, args, timeout) {
  try {
    await execFileAsync(command, args, { timeout });
  } catch {}
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': APP_NAME,
        'Cache-Control': 'no-cache'
      }
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
        response.resume();
        resolve(fetchText(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        // Защита от бесконечного ответа: версия/JSON релиза никогда не бывают такими большими.
        if (data.length > 4 * 1024 * 1024) {
          response.destroy();
          reject(new Error('Ответ слишком большой'));
        }
      });
      response.on('error', reject);
      response.on('end', () => resolve(data));
    });
    request.setTimeout(12000, () => request.destroy(new Error('Timeout')));
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function downloadFile(url, target, redirects = 0, onProgress = null) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    const file = fs.createWriteStream(target);
    let settled = false;

    const cleanup = (removeFile) => {
      if (file.destroyed) return;
      file.destroy();
      if (removeFile) {
        try {
          fs.rmSync(target, { force: true });
        } catch {}
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup(true);
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Без этого обработчика ошибка записи на диск валит весь процесс.
    file.on('error', fail);

    const request = https.get(url, { headers: { 'User-Agent': APP_NAME } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
        cleanup(true);
        response.resume();
        succeed(downloadFile(new URL(response.headers.location, url).toString(), target, redirects + 1, onProgress));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        fail(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const total = Number(response.headers['content-length'] || 0);
      let loaded = 0;
      let lastReported = 0;

      response.on('data', (chunk) => {
        loaded += chunk.length;
        // Репортим не чаще, чем раз в 250 КБ, чтобы не забивать IPC.
        if (typeof onProgress === 'function' && (loaded - lastReported > 256 * 1024 || loaded === total)) {
          lastReported = loaded;
          onProgress(loaded, total);
        }
      });
      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => file.close(() => succeed()));
    });

    request.setTimeout(120000, () => request.destroy(new Error('Timeout')));
    request.on('error', fail);
  });
}

function compareVersions(local, remote) {
  if (!local && remote) return -1;
  if (!remote) return 0;
  if (local === remote) return 0;

  const a = tokenizeVersion(local);
  const b = tokenizeVersion(remote);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) return left > right ? 1 : -1;
    } else {
      const diff = String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function tokenizeVersion(version) {
  return String(version)
    .replace(/^v/i, '')
    .match(/\d+|[a-z]+/gi)
    ?.map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase())) || [];
}

function splitLines(chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function ensureTrailingSlash(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteBatchValue(value) {
  return String(value).replace(/%/g, '%%').replace(/"/g, '""');
}

function formatServiceBinPath(config) {
  const argsText = config.args.map(quoteCommandArg).join(' ');
  return `"${config.exe}" ${argsText}`;
}

function formatServiceBinPathForBatch(config) {
  const argsText = config.args.map(quoteCommandArg).join(' ');
  return `\\"${quoteBatchValue(config.exe)}\\" ${argsText}`;
}

function quoteCommandArg(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!/[ \t"]/g.test(value)) return value;

  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
    } else if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1);
      result += char;
      backslashes = 0;
    } else {
      result += '\\'.repeat(backslashes);
      result += char;
      backslashes = 0;
    }
  }
  result += '\\'.repeat(backslashes * 2);
  result += '"';
  return result;
}

async function installZapretService(configName) {
  ensureRequiredLists();
  const config = parseConfig(configName);
  const admin = await isAdministrator();

  if (!admin) {
    await runElevatedServiceInstall(config);
    settings.bestConfig = config.name;
    settings.selectedConfig = config.name;
    saveSettings();
    log(`Windows service installed through UAC: ${config.name}`);
    invalidateServiceCache();
    await sendState();
    return;
  }

  await stopZapretProcesses({ stopService: true, quiet: true });
  await execFileQuiet('sc.exe', ['delete', SERVICE_NAME], 5000);
  await enableTcpTimestamps();
  await execFileAsync('sc.exe', [
    'create',
    SERVICE_NAME,
    'binPath=',
    formatServiceBinPath(config),
    'DisplayName=',
    SERVICE_NAME,
    'start=',
    'auto'
  ], { timeout: 10000 });
  await execFileQuiet('sc.exe', ['description', SERVICE_NAME, 'Zapret DPI bypass software'], 5000);
  await execFileQuiet('sc.exe', ['sdset', SERVICE_NAME, SERVICE_SDDL], 5000);
  await execFileQuiet('reg.exe', [
    'add',
    `HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}`,
    '/v',
    'zapret-discord-youtube',
    '/t',
    'REG_SZ',
    '/d',
    config.name.replace(/\.bat$/i, ''),
    '/f'
  ], 5000);
  await execFileAsync('sc.exe', ['start', SERVICE_NAME], { timeout: 10000 });
  settings.bestConfig = config.name;
  settings.selectedConfig = config.name;
  saveSettings();
  invalidateServiceCache();
  log(`Windows service installed: ${config.name}`);
  await sendState();
}

async function removeZapretService() {
  const admin = await isAdministrator();

  if (!admin) {
    await runElevatedServiceRemove();
    log('Windows service removed through UAC');
    invalidateServiceCache();
    await sendState();
    return;
  }

  await execFileQuiet('sc.exe', ['stop', SERVICE_NAME], 7000);
  await execFileQuiet('sc.exe', ['delete', SERVICE_NAME], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert14'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert14'], 7000);
  invalidateServiceCache();
  log('Windows service removed');
  await sendState();
}

async function runElevatedServiceInstall(config) {
  const configBaseName = quoteBatchValue(config.name.replace(/\.bat$/i, ''));
  const binPathArg = formatServiceBinPathForBatch(config);
  const lines = [
    'sc stop zapret >nul 2>&1',
    'sc delete zapret >nul 2>&1',
    'ping -n 2 127.0.0.1 >nul',
    'taskkill /IM winws.exe /F >nul 2>&1',
    'netsh interface tcp set global timestamps=enabled >nul 2>&1',
    `sc create ${SERVICE_NAME} binPath= "${binPathArg}" DisplayName= "${SERVICE_NAME}" start= auto`,
    'if errorlevel 1 goto :failed',
    `sc description ${SERVICE_NAME} "Zapret DPI bypass software"`,
    `sc sdset ${SERVICE_NAME} "${SERVICE_SDDL}" >nul 2>&1`,
    `reg add "HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}" /v zapret-discord-youtube /t REG_SZ /d "${configBaseName}" /f >nul`,
    `sc start ${SERVICE_NAME}`,
    'if errorlevel 1 goto :failed'
  ];
  await runElevatedBatchScript(lines, 'install-service', { strict: false });
}

async function runElevatedServiceRemove() {
  const lines = [
    'sc stop zapret >nul 2>&1',
    'sc delete zapret >nul 2>&1',
    'taskkill /IM winws.exe /F >nul 2>&1',
    'sc stop WinDivert >nul 2>&1',
    'sc delete WinDivert >nul 2>&1',
    'sc stop WinDivert14 >nul 2>&1',
    'sc delete WinDivert14 >nul 2>&1'
  ];
  await runElevatedBatchScript(lines, 'remove-service', { strict: false });
}

async function runElevatedBatchScript(lines, name, options = {}) {
  const strict = options.strict !== false;
  const dir = path.join(app.getPath('userData'), 'elevated');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const scriptPath = path.join(dir, `${name}-${stamp}.cmd`);
  const logPath = path.join(dir, `${name}-${stamp}.log`);
  const scriptBody = [
    '@echo off',
    'chcp 437 >nul',
    ...lines
  ];

  if (strict) {
    scriptBody.push('if errorlevel 1 goto :failed');
  }

  scriptBody.push(
    `echo OK>"${logPath}"`,
    'exit /b 0',
    ':failed',
    `echo FAILED %ERRORLEVEL%>"${logPath}"`,
    'exit /b %ERRORLEVEL%'
  );
  fs.writeFileSync(scriptPath, scriptBody.join('\r\n'), 'utf8');

  const elevateExe = resolveElevateExe();
  let elevationError = null;

  try {
    if (elevateExe) {
      await execFileAsync(elevateExe, ['-wait', 'cmd', '/c', scriptPath], { timeout: 120000 });
    } else {
      const command = [
        `$p = Start-Process -FilePath 'cmd.exe'`,
        `-ArgumentList '/c',${quotePowerShellSingle(scriptPath)}`,
        '-Verb RunAs -WindowStyle Normal -Wait -PassThru;',
        'if ($null -eq $p) { exit 1223 }',
        'if ($null -eq $p.ExitCode) { exit 0 }',
        'exit $p.ExitCode'
      ].join(' ');
      await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 120000 });
    }
  } catch (error) {
    elevationError = error;
  }

  await delay(250);

  let detail = '';
  try {
    if (fs.existsSync(logPath)) detail = fs.readFileSync(logPath, 'utf8').trim();
  } catch {}

  try {
    if (detail === 'OK') return;

    if (detail.startsWith('FAILED')) {
      const code = detail.replace(/^FAILED\s*/, '').trim();
      if (code === '1223') {
        throw new Error('Запрос UAC был отклонён. Нажмите «Установить» ещё раз и подтвердите окно контроля учётных записей.');
      }
      if (code === '1060') {
        throw new Error('Служба не найдена (код 1060). Попробуйте установить ещё раз — если ошибка повторится, перезапустите приложение от администратора.');
      }
      if (code === '1072') {
        throw new Error('Служба помечена для удаления (код 1072). Подождите 10 секунд и нажмите «Установить» снова.');
      }
      throw new Error(`Ошибка установки службы (код ${code || 'unknown'}). Убедитесь, что другой bypass не мешает.`);
    }

    if (!detail && elevationError) {
      const msg = String(elevationError.message || '');
      if (/1223|canceled|cancelled|operation was canceled|отмен/i.test(msg)) {
        throw new Error('Запрос UAC не выполнен. Подтвердите окно «Разрешить этому приложению вносить изменения?» — оно может быть за другими окнами.');
      }
    }

    throw new Error('Не удалось выполнить действие с правами администратора. Подтвердите UAC или запустите приложение от администратора.');
  } finally {
    fs.rm(scriptPath, { force: true }, () => {});
    fs.rm(logPath, { force: true }, () => {});
  }
}

function resolveElevateExe() {
  const candidates = [
    path.join(process.resourcesPath, 'elevate.exe'),
    path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'elevate.exe')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
