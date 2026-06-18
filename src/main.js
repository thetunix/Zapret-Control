const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Zapret Control Center';
const UPDATE_REPO = 'Flowseal/zapret-discord-youtube';
const VERSION_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/.service/version.txt`;
const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const SERVICE_NAME = 'zapret';
const SERVICE_SDDL = 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRPWPLO;;;IU)(A;;LCRPWPLO;;;AU)';
const startupDebugFile = path.join(process.cwd(), 'startup-debug.log');

const rootDir = resolveZapretRoot();
const binDir = path.join(rootDir, 'bin');
const listsDir = path.join(rootDir, 'lists');
const utilsDir = path.join(rootDir, 'utils');
const winwsExe = path.join(binDir, 'winws.exe');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let winwsChild = null;
let settings = null;
let settingsFile = null;
let logFile = null;
let recentLogs = [];
let activeTest = null;
let lastUpdate = {
  status: 'idle',
  localVersion: null,
  latestVersion: null,
  message: 'Проверка ещё не запускалась'
};

const defaultSettings = {
  selectedConfig: 'general.bat',
  bestConfig: 'general.bat',
  theme: 'figma',
  launchAtLogin: true,
  autoStartZapret: true,
  autoUpdateZapret: true,
  startMinimized: false,
  gameFilterMode: 'disabled',
  testMode: 'fast',
  ambientIntensity: 72,
  glassBlur: 18,
  motionSpeed: 55
};

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
  ensureUserLists();
  syncLoginItem();
  createWindow();
  writeStartupDebug('window created');
  createTray();
  writeStartupDebug('tray created');
  registerIpc();
  log(`Приложение запущено. Корень zapret: ${rootDir}`);
  const runningAtLaunch = await getWinwsStatus();
  if (runningAtLaunch.active) {
    log(`Подхвачен уже запущенный winws.exe: ${runningAtLaunch.processes.length} процесс(ов)`);
  }

  const startHidden = process.argv.includes('--startup') && settings.startMinimized;
  if (startHidden) {
    mainWindow.hide();
    writeStartupDebug('window hidden');
  } else {
    mainWindow.show();
    writeStartupDebug('window shown');
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

function writeStartupDebug(message) {
  try {
    fs.appendFileSync(startupDebugFile, `[${new Date().toISOString()}] ${message}${os.EOL}`, 'utf8');
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

function createWindow() {
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
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: showMainWindow },
    { label: 'Включить zapret', click: () => startZapret(settings.bestConfig || settings.selectedConfig).catch((error) => log(error.message, 'error')) },
    { label: 'Остановить zapret', click: () => stopZapretProcesses({ stopService: true }).catch((error) => log(error.message, 'error')) },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('double-click', showMainWindow);
}

function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function registerIpc() {
  ipcMain.handle('state:get', async () => buildState());
  ipcMain.handle('window:hide', () => {
    mainWindow?.hide();
    return true;
  });
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
    await stopZapretProcesses({ stopService: true });
    await startZapret(configName || settings.selectedConfig, { remember: true, reason: 'manual' });
    return buildState();
  });

  ipcMain.handle('settings:set', async (_event, patch) => {
    settings = { ...settings, ...sanitizeSettingsPatch(patch) };
    if (patch?.gameFilterMode) setGameFilterMode(settings.gameFilterMode);
    saveSettings();
    syncLoginItem();
    sendState();
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
    send('log:cleared', true);
    return true;
  });

  ipcMain.handle('updates:check', async (_event, options) => {
    await checkForZapretUpdate({ apply: Boolean(options?.apply) });
    return buildState();
  });
  ipcMain.handle('updates:openRelease', () => shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`));

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
    return { ...defaultSettings, ...file, gameFilterMode: readGameFilterMode(file.gameFilterMode) };
  } catch {
    return { ...defaultSettings, gameFilterMode: readGameFilterMode(defaultSettings.gameFilterMode) };
  }
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
  if (typeof patch.theme === 'string') safe.theme = patch.theme;
  if (typeof patch.launchAtLogin === 'boolean') safe.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.autoStartZapret === 'boolean') safe.autoStartZapret = patch.autoStartZapret;
  if (typeof patch.autoUpdateZapret === 'boolean') safe.autoUpdateZapret = patch.autoUpdateZapret;
  if (typeof patch.startMinimized === 'boolean') safe.startMinimized = patch.startMinimized;
  if (typeof patch.testMode === 'string') safe.testMode = patch.testMode;
  if (['disabled', 'all', 'tcp', 'udp'].includes(patch.gameFilterMode)) safe.gameFilterMode = patch.gameFilterMode;
  if (Number.isFinite(Number(patch.ambientIntensity))) safe.ambientIntensity = clampNumber(patch.ambientIntensity, 0, 100);
  if (Number.isFinite(Number(patch.glassBlur))) safe.glassBlur = clampNumber(patch.glassBlur, 0, 32);
  if (Number.isFinite(Number(patch.motionSpeed))) safe.motionSpeed = clampNumber(patch.motionSpeed, 0, 100);
  return safe;
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

async function buildState() {
  const [running, admin, service] = await Promise.all([
    getWinwsStatus(),
    isAdministrator(),
    getServiceStatus()
  ]);

  return {
    appName: APP_NAME,
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
    logs: recentLogs.slice(-160)
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function sendState() {
  send('state:update', await buildState());
}

function log(message, type = 'info') {
  const entry = {
    time: new Date().toISOString(),
    type,
    message: String(message)
  };
  recentLogs.push(entry);
  if (recentLogs.length > 600) recentLogs = recentLogs.slice(-600);

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFile(logFile, `[${entry.time}] [${type.toUpperCase()}] ${entry.message}${os.EOL}`, () => {});
  }

  send('log:new', entry);
}

function readLogFile() {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

function getConfigs() {
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
  const config = parseConfig(configName || settings.selectedConfig);
  ensureUserLists();

  const service = await getServiceStatus();
  if (service.installed && options.useService !== false) {
    if (service.configName && service.configName !== config.name) {
      await installZapretService(config.name);
      await sendState();
      return config;
    }

    await stopZapretProcesses({ stopService: true, quiet: true, killProcesses: false });
    log(`Starting zapret service: ${config.name}`);
    await execFileAsync('sc.exe', ['start', SERVICE_NAME], { timeout: 10000 });

    if (options.remember !== false) {
      settings.selectedConfig = config.name;
      saveSettings();
    }

    await delay(500);
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
    log(`winws.exe остановлен: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    winwsChild = null;
    sendState();
  });

  await delay(500);
  await sendState();
  return config;
}

async function stopZapretProcesses(options = {}) {
  const { stopService = true, quiet = false, killProcesses = true } = options;

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
    const script = `Get-CimInstance Win32_Process -Filter "Name='winws.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    await execFileQuiet('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 10000);
  }

  if (!quiet) log('zapret остановлен');
  await sendState();
}

async function enableTcpTimestamps() {
  await execFileQuiet('netsh.exe', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], 7000);
}

async function getWinwsStatus() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='winws.exe'" | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress`;

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 7000 });
    const text = stdout.trim();
    if (!text) return { active: false, processes: [], managedCount: 0, externalCount: 0 };
    const data = JSON.parse(text);
    const processes = (Array.isArray(data) ? data : [data]).map(normalizeWinwsProcess);
    const managedCount = processes.filter((processInfo) => processInfo.managed).length;
    return {
      active: processes.length > 0,
      processes,
      managedCount,
      externalCount: processes.length - managedCount
    };
  } catch {
    return {
      active: Boolean(winwsChild),
      processes: winwsChild ? [{ ProcessId: winwsChild.pid, CommandLine: 'started by app', managed: true }] : [],
      managedCount: winwsChild ? 1 : 0,
      externalCount: 0
    };
  }
}

function normalizeWinwsProcess(processInfo) {
  const executablePath = processInfo.ExecutablePath || processInfo.executablePath || '';
  const normalizedExe = path.normalize(executablePath).toLowerCase();
  const normalizedRoot = path.normalize(rootDir).toLowerCase();
  const normalizedWinws = path.normalize(winwsExe).toLowerCase();
  const managed = normalizedExe === normalizedWinws || normalizedExe.startsWith(`${normalizedRoot}${path.sep}`);

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
    const state = stdout.match(/STATE\s*:\s*\d+\s+([A-Z_]+)/i)?.[1] || 'UNKNOWN';
    const configName = await readServiceConfigName();
    return { installed: true, state, configName };
  } catch {
    return { installed: false, state: 'NOT_INSTALLED', configName: null };
  }
}

async function readServiceConfigName() {
  try {
    const { stdout } = await execFileAsync('reg.exe', [
      'query',
      `HKLM\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}`,
      '/v',
      'zapret-discord-youtube'
    ], { timeout: 5000 });
    const raw = stdout.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    if (!raw) return null;
    return /\.bat$/i.test(raw) ? raw : `${raw}.bat`;
  } catch {
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
  ensureUserLists();
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
  ensureUserLists();
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
  ensureUserLists();

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

async function installZapretService(configName) {
  const admin = await isAdministrator();
  if (!admin) throw new Error('Для установки службы нужны права администратора');

  const config = parseConfig(configName);
  await stopZapretProcesses({ stopService: true, quiet: true });
  await execFileQuiet('sc.exe', ['delete', 'zapret'], 5000);
  await enableTcpTimestamps();

  await execFileAsync('sc.exe', [
    'create',
    'zapret',
    'binPath=',
    config.commandLine,
    'DisplayName=',
    'zapret',
    'start=',
    'auto'
  ], { timeout: 10000 });
  await execFileQuiet('sc.exe', ['description', 'zapret', 'Zapret DPI bypass software'], 5000);
  await execFileQuiet('reg.exe', [
    'add',
    'HKLM\\System\\CurrentControlSet\\Services\\zapret',
    '/v',
    'zapret-discord-youtube',
    '/t',
    'REG_SZ',
    '/d',
    config.name.replace(/\.bat$/i, ''),
    '/f'
  ], 5000);
  await execFileAsync('sc.exe', ['start', 'zapret'], { timeout: 10000 });
  settings.bestConfig = config.name;
  settings.selectedConfig = config.name;
  saveSettings();
  log(`Служба zapret установлена: ${config.name}`);
}

async function removeZapretService() {
  const admin = await isAdministrator();
  if (!admin) throw new Error('Для удаления службы нужны права администратора');
  await execFileQuiet('sc.exe', ['stop', 'zapret'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'zapret'], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert14'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert14'], 7000);
  log('Служба zapret удалена');
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
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve(data));
    });
    request.setTimeout(12000, () => request.destroy(new Error('Timeout')));
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function downloadFile(url, target, redirects = 0) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const file = fs.createWriteStream(target);
    const request = https.get(url, { headers: { 'User-Agent': APP_NAME } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
        file.close();
        fs.rmSync(target, { force: true });
        response.resume();
        resolve(downloadFile(new URL(response.headers.location, url).toString(), target, redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        file.close();
        fs.rmSync(target, { force: true });
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    request.setTimeout(120000, () => request.destroy(new Error('Timeout')));
    request.on('error', (error) => {
      file.close();
      fs.rmSync(target, { force: true });
      reject(error);
    });
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
  const config = parseConfig(configName);
  const admin = await isAdministrator();

  if (!admin) {
    await runElevatedServiceInstall(config);
    settings.bestConfig = config.name;
    settings.selectedConfig = config.name;
    saveSettings();
    log(`Windows service installed through UAC: ${config.name}`);
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
    config.commandLine,
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
  log(`Windows service installed: ${config.name}`);
  await sendState();
}

async function removeZapretService() {
  const admin = await isAdministrator();

  if (!admin) {
    await runElevatedServiceRemove();
    log('Windows service removed through UAC');
    await sendState();
    return;
  }

  await execFileQuiet('sc.exe', ['stop', SERVICE_NAME], 7000);
  await execFileQuiet('sc.exe', ['delete', SERVICE_NAME], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert'], 7000);
  await execFileQuiet('sc.exe', ['stop', 'WinDivert14'], 7000);
  await execFileQuiet('sc.exe', ['delete', 'WinDivert14'], 7000);
  log('Windows service removed');
  await sendState();
}

async function runElevatedServiceInstall(config) {
  const serviceKey = `HKLM:\\System\\CurrentControlSet\\Services\\${SERVICE_NAME}`;
  const script = `
$ErrorActionPreference = 'Stop'
function Invoke-Native {
  param([Parameter(Mandatory=$true)][string]$FilePath, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}
sc.exe stop ${quotePowerShellSingle(SERVICE_NAME)} | Out-Null
sc.exe delete ${quotePowerShellSingle(SERVICE_NAME)} | Out-Null
Start-Sleep -Milliseconds 700
Get-CimInstance Win32_Process -Filter "Name='winws.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Invoke-Native netsh.exe interface tcp set global timestamps=enabled
Invoke-Native sc.exe create ${quotePowerShellSingle(SERVICE_NAME)} binPath= ${quotePowerShellSingle(config.commandLine)} DisplayName= ${quotePowerShellSingle(SERVICE_NAME)} start= auto
Invoke-Native sc.exe description ${quotePowerShellSingle(SERVICE_NAME)} 'Zapret DPI bypass software'
Invoke-Native sc.exe sdset ${quotePowerShellSingle(SERVICE_NAME)} ${quotePowerShellSingle(SERVICE_SDDL)}
New-Item -Path ${quotePowerShellSingle(serviceKey)} -Force | Out-Null
New-ItemProperty -Path ${quotePowerShellSingle(serviceKey)} -Name 'zapret-discord-youtube' -PropertyType String -Value ${quotePowerShellSingle(config.name.replace(/\.bat$/i, ''))} -Force | Out-Null
Invoke-Native sc.exe start ${quotePowerShellSingle(SERVICE_NAME)}
`;
  await runElevatedPowerShellScript(script, 'install-service');
}

async function runElevatedServiceRemove() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
sc.exe stop ${quotePowerShellSingle(SERVICE_NAME)} | Out-Null
sc.exe delete ${quotePowerShellSingle(SERVICE_NAME)} | Out-Null
sc.exe stop WinDivert | Out-Null
sc.exe delete WinDivert | Out-Null
sc.exe stop WinDivert14 | Out-Null
sc.exe delete WinDivert14 | Out-Null
`;
  await runElevatedPowerShellScript(script, 'remove-service');
}

async function runElevatedPowerShellScript(script, name) {
  const dir = path.join(app.getPath('userData'), 'elevated');
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, `${name}-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, script.trim(), 'utf8');

  const command = [
    `$p = Start-Process -FilePath 'powershell.exe'`,
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${quotePowerShellSingle(scriptPath)})`,
    '-Verb RunAs -Wait -PassThru;',
    'exit $p.ExitCode'
  ].join(' ');

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 120000 });
  } catch (error) {
    throw new Error(`Elevated action failed or was cancelled: ${error.message}`);
  } finally {
    fs.rm(scriptPath, { force: true }, () => {});
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
