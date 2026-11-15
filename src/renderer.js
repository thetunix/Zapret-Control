const themes = [
  { id: 'figma', name: 'Figma Dark', hint: 'violet glass' },
  { id: 'aurora', name: 'Aurora', hint: 'teal amber' },
  { id: 'graphite', name: 'Graphite', hint: 'neutral lime' },
  { id: 'ember', name: 'Ember', hint: 'warm blue' },
  { id: 'glacier', name: 'Glacier', hint: 'ice violet' },
  { id: 'orchid', name: 'Orchid', hint: 'soft purple' },
  { id: 'forest', name: 'Forest', hint: 'green gold' },
  { id: 'ruby', name: 'Ruby', hint: 'rose cyan' },
  { id: 'noir', name: 'Noir', hint: 'mono mint' },
  { id: 'midnight', name: 'Midnight', hint: 'deep blue' },
  { id: 'sunset', name: 'Sunset', hint: 'coral pink' },
  { id: 'matrix', name: 'Matrix', hint: 'neon green' },
  { id: 'cyber', name: 'Cyberpunk', hint: 'yellow magenta' },
  { id: 'sakura', name: 'Sakura', hint: 'pink violet' },
  { id: 'mocha', name: 'Mocha', hint: 'coffee cream' },
  { id: 'nord', name: 'Nord', hint: 'cold steel' },
  { id: 'dracula', name: 'Dracula', hint: 'purple pink' },
  { id: 'gold', name: 'Gold', hint: 'black gold' },
  { id: 'ocean', name: 'Ocean', hint: 'blue teal' },
  { id: 'custom', name: 'Своя', hint: 'настраивается ниже' }
];

const defaultCustomTheme = {
  accent: '#7c5cff',
  accent2: '#32d6c8',
  accent3: '#5b7bff',
  bg: '#0b0b0f'
};

const LOG_LIMIT = 200;
const LOG_ROWS_VISIBLE = 120;
const TOAST_LIMIT = 4;

let state = null;
let logs = [];
let testRunning = false;
let renderQueued = false;
let logsRenderQueued = false;
let metricsTimer = null;
let logSeq = 0;
let editorModel = null;
let editorLoadId = 0;
let editorPreviewId = 0;
let editorPreviewTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindControls();
  bindPowerSaving();
  initThemes();
  await refreshState(true);
  await initStrategyEditor();
  await refreshGeneralList();
  await refreshLogs();
});

window.zapret.onState((nextState) => {
  state = nextState;
  scheduleRender();
});

window.zapret.onLog((entry) => {
  logs.push(withSeq(entry));
  if (logs.length > LOG_LIMIT) logs = logs.slice(-LOG_LIMIT);
  scheduleLogsRender();
});

window.zapret.onLogCleared(() => {
  logs = [];
  const preview = $('#homeLogs');
  if (preview) {
    preview.textContent = '';
    preview.dataset.lastSeq = '0';
  }
});

function withSeq(entry) {
  logSeq += 1;
  entry.seq = logSeq;
  return entry;
}

// Пока окно скрыто или свёрнуто, рендерить нечего — копим и рисуем один раз при возврате.
function scheduleRender() {
  if (document.hidden) {
    renderQueued = true;
    return;
  }
  renderState();
}

function scheduleLogsRender() {
  if (document.hidden || logsRenderQueued) {
    logsRenderQueued = true;
    return;
  }
  logsRenderQueued = true;
  requestAnimationFrame(() => {
    logsRenderQueued = false;
    if (!document.hidden) renderLogs();
  });
}

function bindPowerSaving() {
  const syncMotion = () => {
    const idle = document.hidden || !document.hasFocus();
    document.body.classList.toggle('motion-idle', idle);
  };

  document.addEventListener('visibilitychange', () => {
    syncMotion();
    if (document.hidden) {
      stopMetricsTimer();
      return;
    }
    if (renderQueued) {
      renderQueued = false;
      renderState();
    }
    if (logsRenderQueued) {
      logsRenderQueued = false;
      renderLogs();
    }
    refreshState().catch(() => {});
  });

  window.addEventListener('focus', syncMotion);
  window.addEventListener('blur', syncMotion);
  syncMotion();
}

window.zapret.onUpdateProgress((update) => {
  if (!state) return;
  state.update = update;
  renderUpdate();
});

window.zapret.onAppUpdateProgress((appUpdate) => {
  if (!state) state = {};
  state.appUpdate = appUpdate;
  renderAppUpdateBanner();
  renderAppUpdateSettings();
});

window.zapret.onNotification((payload) => {
  showToast(payload.type || 'info', payload.message || '', {
    title: payload.title,
    duration: payload.persistent ? 0 : 7000,
    action: payload.action
  });
});

window.zapret.onTestsStart((info) => {
  testRunning = true;
  $('#testResults').innerHTML = '';
  $('#testTitle').textContent = 'Тесты запущены';
  $('#testDetail').textContent = `${info.total} конфигов, целей: ${info.targets}`;
  setProgress(0);
});

window.zapret.onTestsProgress((info) => {
  $('#testTitle').textContent = info.config;
  $('#testDetail').textContent = `${info.index + 1}/${info.total}`;
  setProgress((info.index / info.total) * 100);
});

window.zapret.onTestsTarget((info) => {
  $('#testDetail').textContent = `${info.config}: ${info.target} (${info.targetIndex + 1}/${info.totalTargets})`;
});

window.zapret.onTestsResult((result) => {
  appendTestResult(result);
});

window.zapret.onTestsDone(async (payload) => {
  testRunning = false;
  setProgress(100);
  $('#testTitle').textContent = payload.best ? `Лучший: ${payload.best.config}` : 'Тест завершён';
  $('#testDetail').textContent = payload.cancelled ? 'Остановлено' : 'Готово';
  await refreshState();
});

window.zapret.onTestsError((error) => {
  testRunning = false;
  $('#testTitle').textContent = 'Ошибка тестов';
  $('#testDetail').textContent = error.message;
});

window.zapret.onMonitor((monitor) => {
  if (!state) return;
  state.monitor = monitor;
  renderMonitor();
});

window.zapret.onDiagnostics((rows) => {
  if (!state) return;
  state.diagnostics = rows;
  renderDiagnostics();
});

function bindTabs() {
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.nav-item').forEach((item) => item.classList.remove('active'));
      $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      $(`#tab-${button.dataset.tab}`).classList.add('active');
      if (button.dataset.tab === 'logs') refreshLogs();
      if (button.dataset.tab === 'monitor' && !state?.monitor?.checkedAt) refreshMonitor();
      if (button.dataset.tab === 'settings') startMetricsTimer();
      else stopMetricsTimer();
    });
  });
}

function startMetricsTimer() {
  refreshMetrics();
  if (metricsTimer) return;
  metricsTimer = setInterval(() => {
    if (document.hidden) return;
    refreshMetrics();
  }, 5000);
}

function stopMetricsTimer() {
  if (!metricsTimer) return;
  clearInterval(metricsTimer);
  metricsTimer = null;
}

async function refreshMetrics() {
  const target = $('#memoryState');
  if (!target) return;

  try {
    const metrics = await window.zapret.getMetrics();
    target.textContent = `${metrics.totalMb} МБ`;
    const notice = $('#memoryNotice');
    if (notice) {
      notice.textContent = metrics.windowLoaded
        ? `Фон: ${metrics.mainMb} МБ · интерфейс: ${metrics.rendererMb} МБ · опрос каждые ${Math.round(metrics.pollIntervalMs / 1000)} с`
        : `Интерфейс выгружен, фон: ${metrics.mainMb} МБ`;
    }
  } catch {
    target.textContent = 'н/д';
  }
}

function bindControls() {
  $('#hideToTrayBtn').addEventListener('click', () => window.zapret.hideWindow());
  $('#openRootBtn').addEventListener('click', () => window.zapret.openRoot());
  $('#openLogsBtn').addEventListener('click', () => window.zapret.openLogs());
  $('#adminBtn').addEventListener('click', () => window.zapret.relaunchAdmin());

  $('#startBtn').addEventListener('click', async () => {
    if (state?.running?.active) {
      await action(() => window.zapret.stop());
    } else {
      await action(() => window.zapret.start($('#configSelect').value));
    }
  });
  $('#stopBtn').addEventListener('click', async () => action(() => window.zapret.stop()));
  $('#restartBtn').addEventListener('click', async () => action(() => window.zapret.restart($('#configSelect').value)));
  $('#configSelect').addEventListener('change', async () => {
    await window.zapret.setSettings({ selectedConfig: $('#configSelect').value });
    await refreshState();
  });

  $('#launchAtLoginToggle').addEventListener('change', (event) => patchSetting({ launchAtLogin: event.target.checked }));
  $('#unloadWindowToggle')?.addEventListener('change', (event) => patchSetting({ unloadWindowInTray: event.target.checked }));
  $('#ecoModeToggle')?.addEventListener('change', (event) => patchSetting({ ecoMode: event.target.checked }));
  $('#disableGpuToggle')?.addEventListener('change', async (event) => {
    await patchSetting({ disableGpu: event.target.checked });
    showToast('info', 'Настройка применится после перезапуска приложения', { title: 'Аппаратное ускорение' });
  });
  $('#startMinimizedToggle')?.addEventListener('change', (event) => patchSetting({ startMinimized: event.target.checked }));
  $('#watchdogToggle')?.addEventListener('change', (event) => patchSetting({ watchdog: event.target.checked }));
  $('#hotkeyToggle')?.addEventListener('change', (event) => patchSetting({ toggleHotkey: event.target.checked }));
  $('#unloadWindowBtn')?.addEventListener('click', () => window.zapret.unloadWindow());
  $('#autoStartToggle').addEventListener('change', (event) => patchSetting({ autoStartZapret: event.target.checked }));
  $('#autoUpdateToggle').addEventListener('change', (event) => patchSetting({ autoUpdateZapret: event.target.checked }));
  $('#checkUpdateBtn').addEventListener('click', async () => action(() => window.zapret.checkUpdates({ apply: true })));
  $('#checkAppUpdateBtn')?.addEventListener('click', async () => {
    try {
      const result = await window.zapret.checkAppUpdate();
      state = result;
      renderState();
      if (result.appUpdate?.status === 'up-to-date') {
        showToast('success', result.appUpdate.message, { title: 'Обновления' });
      } else if (result.appUpdate?.status === 'downloaded') {
        showToast('success', 'Обновление скачано — нажмите «Установить»', { title: 'Готово' });
      }
    } catch (error) {
      showToast('error', error.message || String(error), { title: 'Ошибка обновления', duration: 9000 });
    }
  });
  $('#installAppUpdateBtn')?.addEventListener('click', async () => action(() => window.zapret.installAppUpdate()));
  $('#openReleaseBtn').addEventListener('click', () => window.zapret.openRelease());
  bindRange('#ambientIntensityRange', 'ambientIntensity');
  bindRange('#glassBlurRange', 'glassBlur');
  bindRange('#motionSpeedRange', 'motionSpeed');

  $('#startTestsBtn').addEventListener('click', async () => {
    if (testRunning) return;
    await window.zapret.setSettings({ testMode: $('#testModeSelect').value });
    await action(() => window.zapret.startTests({ mode: $('#testModeSelect').value, applyBest: true }));
  });
  $('#cancelTestsBtn').addEventListener('click', () => window.zapret.cancelTests());

  $('#monitorEnabledToggle').addEventListener('change', async (event) => patchSetting({ monitorEnabled: event.target.checked }));
  $('#smartSwitchToggle').addEventListener('change', async (event) => {
    await patchSetting({ smartSwitchEnabled: event.target.checked });
    if (event.target.checked) showToast('info', 'Автоматический выбор использует результаты тестов. При изменении службы могут понадобиться права администратора.', { title: 'Автопереключение' });
  });
  $('#checkMonitorBtn').addEventListener('click', refreshMonitor);
  $('#runDiagnosticsBtn').addEventListener('click', refreshDiagnostics);
  $('#editorBaseConfig').addEventListener('change', loadStrategyEditor);
  $('#editorName').addEventListener('input', scheduleEditorPreview);
  $('#editorPreviewBtn').addEventListener('click', refreshEditorPreview);
  $('#editorSaveBtn').addEventListener('click', async () => {
    if (!editorModel) return;
    try {
      const result = await window.zapret.saveStrategy(editorPayload());
      showToast('success', `Создан ${result.filename}. Выберите его на главной и запустите.`, { title: 'Стратегия сохранена', duration: 8000 });
      await refreshState();
      refreshEditorChoices();
    } catch (error) {
      showToast('error', error.message || String(error), { title: 'Не удалось создать стратегию', duration: 9000 });
    }
  });

  $('#reloadListBtn').addEventListener('click', refreshGeneralList);
  $('#domainForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#domainInput');
    if (!input.value.trim()) return;
    await action(() => window.zapret.addGeneralDomain(input.value));
    input.value = '';
    await refreshGeneralList();
  });
  $('#saveDomainsBtn').addEventListener('click', async () => {
    const domains = $('#domainTextarea').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    await action(() => window.zapret.saveGeneralDomains(domains));
    await refreshGeneralList();
  });

  $('#clearLogsBtn').addEventListener('click', async () => {
    await window.zapret.clearLogs();
    await refreshLogs();
  });

  $('#installServiceBtn').addEventListener('click', async () => {
    showToast('info', 'Сейчас появится запрос UAC Windows. Подтвердите его — окно может быть за другими программами.', {
      title: 'Установка службы',
      duration: 9000
    });
    await action(() => window.zapret.installService($('#configSelect').value), {
      successMessage: 'Служба Windows установлена'
    });
  });
  $('#removeServiceBtn').addEventListener('click', async () => {
    showToast('info', 'Подтвердите запрос UAC для удаления службы.', { title: 'Удаление службы', duration: 7000 });
    await action(() => window.zapret.removeService(), { successMessage: 'Служба Windows удалена' });
  });

  ['#customAccent', '#customAccent2', '#customAccent3', '#customBg'].forEach((selector) => {
    $(selector)?.addEventListener('input', () => {
      applyCustomTheme(readCustomThemeInputs());
      document.body.dataset.theme = 'custom';
    });
  });

  $('#applyCustomThemeBtn')?.addEventListener('click', async () => {
    const customTheme = readCustomThemeInputs();
    applyCustomTheme(customTheme);
    document.body.dataset.theme = 'custom';
    await patchSetting({ theme: 'custom', customTheme });
    showToast('success', 'Своя тема применена', { title: 'Темы', duration: 4000 });
  });

  $('#randomCustomThemeBtn')?.addEventListener('click', async () => {
    const customTheme = {
      accent: randomHexColor(55, 70),
      accent2: randomHexColor(60, 78),
      accent3: randomHexColor(50, 68),
      bg: randomHexColor(4, 9)
    };
    applyCustomTheme(customTheme);
    document.body.dataset.theme = 'custom';
    await patchSetting({ theme: 'custom', customTheme });
  });

  $('#gameFilterGroup').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    await patchSetting({ gameFilterMode: button.dataset.mode });
  });
}

async function refreshState(initial = false) {
  state = await window.zapret.getState();
  if (initial) {
    logs = (state.logs || []).slice(-LOG_LIMIT).map(withSeq);
    renderLogs();
  }
  renderState();
}

function renderState() {
  if (!state) return;

  document.body.dataset.theme = state.settings.theme || 'aurora';
  applyCustomTheme();
  applyVisualSettings();
  $('#rootPath').textContent = state.rootDir;
  const adopted = state.running.active && state.running.externalCount > 0 && state.running.managedCount === 0;
  $('#miniStatus').textContent = state.running.active ? (adopted ? 'winws подхвачен' : 'zapret включён') : 'zapret выключен';
  $('#statusText').textContent = state.running.active ? (adopted ? 'winws подхвачен' : 'zapret работает') : 'zapret остановлен';
  $('#processNote').textContent = renderProcessNote(state.running);
  $('#statusPulse').classList.toggle('online', state.running.active);
  $('#startBtn').classList.toggle('online', state.running.active);
  $('#startBtn').setAttribute('aria-label', state.running.active ? 'Остановить zapret' : 'Включить zapret');
  $('#bestConfig').textContent = state.settings.bestConfig || 'не выбран';
  $('#serviceState').textContent = formatServiceState(state.service, 'short');
  $('#versionState').textContent = state.versions.local || 'n/a';
  $('#adminLabel').textContent = state.admin ? 'Админ: да' : 'Админ: нет';

  const serviceNotice = $('#serviceNotice');
  serviceNotice.textContent = formatServiceState(state.service, 'long');
  serviceNotice.classList.toggle('notice-good', state.service.installed && state.service.state === 'RUNNING');
  serviceNotice.classList.toggle('notice-warn', state.service.installed && state.service.state !== 'RUNNING');

  renderConfigSelect();
  renderSettings();
  renderUpdate();
  renderAppUpdateBanner();
  renderAppUpdateSettings();
  renderMonitor();
  renderDiagnostics();
  refreshEditorChoices();
  updateThemeSelection();
}

function formatServiceState(service, mode = 'short') {
  if (!service?.installed) {
    return mode === 'long' ? 'Служба Windows не установлена' : 'нет';
  }

  const labels = {
    RUNNING: 'работает',
    STOPPED: 'остановлена',
    START_PENDING: 'запускается',
    STOP_PENDING: 'останавливается',
    PAUSE_PENDING: 'пауза...',
    PAUSED: 'на паузе',
    CONTINUE_PENDING: 'возобновляется',
    UNKNOWN: 'неизвестно',
    NOT_INSTALLED: 'нет'
  };

  const label = labels[service.state] || String(service.state || 'неизвестно').toLowerCase();
  const configLabel = service.configName ? service.configName.replace(/\.bat$/i, '') : null;

  if (mode === 'long') {
    if (configLabel) return `Служба ${label} · конфиг ${configLabel}`;
    return `Служба ${label}`;
  }

  if (configLabel && service.state === 'RUNNING') return `${label}`;
  return label;
}

function renderProcessNote(running) {
  if (!running.active) return 'Готов к запуску выбранного конфига';
  const total = running.processes?.length || 0;
  if (running.externalCount > 0 && running.managedCount === 0) {
    return `Найден уже запущенный winws.exe: ${total}. Можно управлять им отсюда.`;
  }
  if (running.externalCount > 0) {
    return `Активно процессов: ${total}, включая внешний winws.exe`;
  }
  return `Активно процессов: ${total}`;
}

function renderConfigSelect() {
  const select = $('#configSelect');
  const selected = state.settings.selectedConfig || state.settings.bestConfig;
  const signature = state.configs.map((item) => item.name).join('|');

  if (select.dataset.signature !== signature) {
    const current = select.value;
    select.dataset.signature = signature;
    select.innerHTML = '';
    for (const config of state.configs) {
      const option = document.createElement('option');
      option.value = config.name;
      option.textContent = config.label;
      select.appendChild(option);
    }
    select.value = current && state.configs.some((item) => item.name === current) ? current : selected;
    return;
  }

  if (select.value !== selected) {
    select.value = state.configs.some((item) => item.name === selected) ? selected : select.value;
  }
}

function renderSettings() {
  $('#launchAtLoginToggle').checked = Boolean(state.settings.launchAtLogin);
  $('#autoStartToggle').checked = Boolean(state.settings.autoStartZapret);
  $('#autoUpdateToggle').checked = Boolean(state.settings.autoUpdateZapret);
  setChecked('#unloadWindowToggle', state.settings.unloadWindowInTray);
  setChecked('#ecoModeToggle', state.settings.ecoMode);
  setChecked('#disableGpuToggle', state.settings.disableGpu);
  setChecked('#startMinimizedToggle', state.settings.startMinimized);
  setChecked('#watchdogToggle', state.settings.watchdog);
  setChecked('#hotkeyToggle', state.settings.toggleHotkey);

  renderCustomThemeInputs();

  const hotkeyLabel = $('#hotkeyLabel');
  if (hotkeyLabel && state.hotkey?.combo) hotkeyLabel.textContent = state.hotkey.combo;

  const winwsMemory = $('#winwsMemoryState');
  if (winwsMemory) {
    const kb = state.running?.memoryKb || 0;
    winwsMemory.textContent = state.running?.active && kb ? `${Math.round(kb / 1024)} МБ` : '—';
  }
  $('#testModeSelect').value = state.settings.testMode || 'fast';
  $('#ambientIntensityRange').value = state.settings.ambientIntensity ?? 72;
  $('#glassBlurRange').value = state.settings.glassBlur ?? 18;
  $('#motionSpeedRange').value = state.settings.motionSpeed ?? 55;
  updateRangeLabels();

  $$('#gameFilterGroup button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.settings.gameFilterMode);
  });
}

function setChecked(selector, value) {
  const input = $(selector);
  if (input) input.checked = Boolean(value);
}

function renderUpdate() {
  const update = state?.update;
  if (!update) return;
  const notice = $('#updateNotice');
  if (!notice) return;
  notice.textContent = update.message || '...';
  notice.classList.toggle('notice-good', update.status === 'current' || update.status === 'updated');
  notice.classList.toggle('notice-warn', update.status === 'available' || update.status === 'downloading' || update.status === 'installing');
}

function renderAppUpdateSettings() {
  const versionEl = $('#appVersionState');
  const noticeEl = $('#appUpdateNotice');
  const installBtn = $('#installAppUpdateBtn');
  if (!versionEl || !noticeEl) return;

  const current = state?.appVersion || '...';
  const appUpdate = state?.appUpdate;
  const latest = appUpdate?.version;

  if (latest && appUpdate?.status && !['up-to-date', 'idle', 'dev', 'checking'].includes(appUpdate.status)) {
    versionEl.textContent = `${current} → ${latest}`;
  } else {
    versionEl.textContent = current;
  }

  noticeEl.textContent = appUpdate?.message || 'Проверка обновлений при запуске';
  noticeEl.classList.toggle('notice-good', appUpdate?.status === 'up-to-date' || appUpdate?.status === 'downloaded');
  noticeEl.classList.toggle('notice-warn', ['available', 'downloading', 'checking'].includes(appUpdate?.status));
  noticeEl.classList.toggle('notice-error', appUpdate?.status === 'error');

  if (installBtn) installBtn.hidden = appUpdate?.status !== 'downloaded';
}

function renderAppUpdateBanner() {
  const container = $('#appBanners');
  if (!container) return;

  const appUpdate = state?.appUpdate;
  const active = appUpdate && ['available', 'downloading', 'downloaded'].includes(appUpdate.status);
  container.innerHTML = '';

  if (!active) return;

  const banner = document.createElement('div');
  banner.className = `app-banner app-banner-${appUpdate.status}`;

  const text = document.createElement('div');
  text.className = 'app-banner-text';
  text.innerHTML = `
    <strong>${escapeHtml(appUpdate.status === 'downloaded' ? 'Обновление готово' : 'Доступно обновление')}</strong>
    <span>${escapeHtml(appUpdate.message || '')}</span>
  `;

  const actions = document.createElement('div');
  actions.className = 'app-banner-actions';

  if (appUpdate.status === 'downloaded') {
    const installBtn = document.createElement('button');
    installBtn.className = 'primary-button';
    installBtn.textContent = 'Установить';
    installBtn.addEventListener('click', () => action(() => window.zapret.installAppUpdate(), {
      successMessage: 'Приложение перезапустится для установки обновления'
    }));
    actions.appendChild(installBtn);
  } else if (appUpdate.status === 'downloading') {
    const progress = document.createElement('div');
    progress.className = 'app-banner-progress';
    progress.innerHTML = `<span style="width:${Math.round(appUpdate.progress || 0)}%"></span>`;
    actions.appendChild(progress);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'ghost-button app-banner-dismiss';
  dismissBtn.textContent = '×';
  dismissBtn.setAttribute('aria-label', 'Скрыть');
  dismissBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
    setTimeout(() => banner.remove(), 220);
  });

  banner.appendChild(text);
  banner.appendChild(actions);
  banner.appendChild(dismissBtn);
  container.appendChild(banner);
}

function showToast(type, message, options = {}) {
  const stack = $('#toastStack');
  if (!stack || !message) return;

  // Уведомление с тем же действием заменяем, а не копим — иначе стопка растёт бесконечно.
  if (options.action) {
    stack.querySelectorAll(`[data-action="${options.action}"]`).forEach((node) => node.remove());
  }
  while (stack.childElementCount >= TOAST_LIMIT) {
    stack.removeChild(stack.firstElementChild);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}${options.action ? ' toast-actionable' : ''}`;
  if (options.action) toast.dataset.action = options.action;

  const titleHtml = options.title ? `<strong>${escapeHtml(options.title)}</strong>` : '';
  toast.innerHTML = `${titleHtml}<p>${escapeHtml(message)}</p>`;

  if (options.action === 'app-update') {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = 'Установить';
    btn.addEventListener('click', () => action(() => window.zapret.installAppUpdate()));
    toast.appendChild(btn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  closeBtn.addEventListener('click', () => dismissToast(toast));
  toast.appendChild(closeBtn);

  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  if (options.duration !== 0) {
    setTimeout(() => dismissToast(toast), options.duration || 6500);
  }
}

function dismissToast(toast) {
  if (!toast || !toast.isConnected) return;
  toast.classList.remove('visible');
  setTimeout(() => toast.remove(), 260);
}

function initThemes() {
  const grid = $('#themeGrid');
  if (!grid || grid.dataset.bound === '1') return;
  grid.dataset.bound = '1';

  for (const theme of themes) {
    const button = document.createElement('button');
    button.className = `theme-swatch theme-${theme.id}`;
    button.dataset.theme = theme.id;
    button.innerHTML = `<span></span><strong>${theme.name}</strong><small>${theme.hint}</small>`;
    button.addEventListener('click', async () => {
      document.body.dataset.theme = theme.id;
      await patchSetting({ theme: theme.id });
    });
    grid.appendChild(button);
  }
}

function readCustomThemeInputs() {
  return {
    accent: $('#customAccent')?.value || defaultCustomTheme.accent,
    accent2: $('#customAccent2')?.value || defaultCustomTheme.accent2,
    accent3: $('#customAccent3')?.value || defaultCustomTheme.accent3,
    bg: $('#customBg')?.value || defaultCustomTheme.bg
  };
}

function applyCustomTheme(theme = state?.settings?.customTheme) {
  const colors = { ...defaultCustomTheme, ...(theme || {}) };
  const root = document.documentElement.style;
  root.setProperty('--custom-accent', colors.accent);
  root.setProperty('--custom-accent-2', colors.accent2);
  root.setProperty('--custom-accent-3', colors.accent3);
  root.setProperty('--custom-bg', colors.bg);
}

function renderCustomThemeInputs() {
  const colors = { ...defaultCustomTheme, ...(state?.settings?.customTheme || {}) };
  const fields = {
    '#customAccent': colors.accent,
    '#customAccent2': colors.accent2,
    '#customAccent3': colors.accent3,
    '#customBg': colors.bg
  };

  for (const [selector, value] of Object.entries(fields)) {
    const input = $(selector);
    // Не перебиваем значение, пока пользователь держит открытой палитру.
    if (input && document.activeElement !== input) input.value = value;
  }
}

function randomHexColor(minLight, maxLight) {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 55 + Math.floor(Math.random() * 35);
  const light = minLight + Math.floor(Math.random() * (maxLight - minLight));
  return hslToHex(hue, saturation, light);
}

function hslToHex(h, s, l) {
  const saturation = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = saturation * Math.min(light, 1 - light);
  const f = (n) => {
    const value = light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * value).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function updateThemeSelection() {
  const active = state?.settings?.theme || document.body.dataset.theme || 'aurora';
  $$('#themeGrid .theme-swatch').forEach((button) => {
    button.classList.toggle('active', button.dataset.theme === active);
  });
}

function renderThemes() {
  updateThemeSelection();
}

function bindRange(selector, key) {
  const input = $(selector);
  input.addEventListener('input', () => {
    const preview = { ...state?.settings, [key]: Number(input.value) };
    applyVisualSettings(preview);
    updateRangeLabels(preview);
  });
  input.addEventListener('change', () => patchSetting({ [key]: Number(input.value) }));
}

function applyVisualSettings(settingsOverride = state?.settings) {
  const settings = settingsOverride || {};
  const intensity = Number(settings.ambientIntensity ?? 72);
  const blur = Number(settings.glassBlur ?? 18);
  const speed = Number(settings.motionSpeed ?? 55);
  const duration = Math.round(44 - (speed / 100) * 28);

  document.documentElement.style.setProperty('--ambient-opacity', String(Math.max(0, Math.min(1, intensity / 100))));
  document.documentElement.style.setProperty('--glass-blur', `${Math.max(0, Math.min(32, blur))}px`);
  document.documentElement.style.setProperty('--motion-duration-a', `${Math.max(12, duration)}s`);
  document.documentElement.style.setProperty('--motion-duration-b', `${Math.max(14, Math.round(duration * 1.24))}s`);
  document.documentElement.style.setProperty('--motion-duration-c', `${Math.max(13, Math.round(duration * 1.12))}s`);
}

function updateRangeLabels(settingsOverride = state?.settings) {
  const settings = settingsOverride || {};
  const intensity = Number(settings.ambientIntensity ?? 72);
  const blur = Number(settings.glassBlur ?? 18);
  const speed = Number(settings.motionSpeed ?? 55);
  $('#ambientIntensityValue').textContent = `${intensity}%`;
  $('#glassBlurValue').textContent = `${blur}px`;
  $('#motionSpeedValue').textContent = `${speed}%`;
}

async function refreshGeneralList() {
  const data = await window.zapret.getGeneralList();
  $('#domainTextarea').value = data.user.join('\n');
  $('#domainCount').textContent = `${data.user.length} доменов`;
  const base = $('#baseDomains');
  base.innerHTML = '';
  data.base.slice(0, 80).forEach((domain) => {
    const chip = document.createElement('span');
    chip.textContent = domain;
    base.appendChild(chip);
  });
}

async function refreshLogs() {
  const text = await window.zapret.readLogs();
  $('#logFull').textContent = text || 'Лог пуст';
  $('#logFull').scrollTop = $('#logFull').scrollHeight;
}

function renderLogs() {
  const preview = $('#homeLogs');
  if (!preview) return;

  const lastSeq = Number(preview.dataset.lastSeq || 0);
  const fresh = logs.filter((entry) => (entry.seq || 0) > lastSeq);

  // Обычно дописываем только новые строки; полная перерисовка — при первом рендере и очистке.
  if (!preview.childElementCount || fresh.length === logs.length) {
    preview.textContent = '';
    appendLogRows(preview, logs.slice(-LOG_ROWS_VISIBLE));
  } else {
    appendLogRows(preview, fresh);
  }

  while (preview.childElementCount > LOG_ROWS_VISIBLE) {
    preview.removeChild(preview.firstElementChild);
  }

  preview.dataset.lastSeq = String(logs.length ? logs[logs.length - 1].seq || 0 : 0);
}

function appendLogRows(container, entries) {
  if (!entries.length) return;

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `log-row ${entry.type}`;
    row.textContent = `${formatTime(entry.time)} ${entry.message}`;
    fragment.appendChild(row);
  }
  container.appendChild(fragment);
}

function appendTestResult(result) {
  const card = document.createElement('article');
  card.className = 'result-card';
  const ok = result.score.ok;
  const fail = result.score.fail;
  card.innerHTML = `
    <div>
      <strong>${escapeHtml(result.config)}</strong>
      <span>${result.score.total} баллов</span>
    </div>
    <p>OK: ${ok} · Fail: ${fail} · Ping: ${result.score.pingOk}</p>
  `;
  $('#testResults').prepend(card);
}

function setProgress(value) {
  $('#testProgress').style.width = `${Math.max(0, Math.min(100, value))}%`;
}

async function patchSetting(patch) {
  state = await window.zapret.setSettings(patch);
  renderState();
}

async function action(fn, options = {}) {
  try {
    const result = await fn();
    if (result && typeof result === 'object' && result.settings) {
      state = result;
      renderState();
    }
    if (options.successMessage) {
      showToast('success', options.successMessage, { title: 'Готово' });
    }
  } catch (error) {
    showToast('error', error.message || String(error), { title: 'Ошибка', duration: 9000 });
  }
}

function makeElement(tag, className = '', label = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label) node.textContent = label;
  return node;
}

async function refreshMonitor() {
  const button = $('#checkMonitorBtn');
  button.disabled = true;
  try {
    const monitor = await window.zapret.checkMonitor();
    if (state) state.monitor = monitor;
    renderMonitor();
  } catch (error) {
    showToast('error', error.message || String(error), { title: 'Мониторинг' });
  } finally {
    button.disabled = false;
  }
}

function renderMonitor() {
  if (!state) return;
  const monitor = state.monitor || { services: {} };
  setChecked('#monitorEnabledToggle', state.settings.monitorEnabled);
  setChecked('#smartSwitchToggle', state.settings.smartSwitchEnabled);
  const when = monitor.checkedAt
    ? `Обновлено ${new Date(monitor.checkedAt).toLocaleTimeString('ru-RU')}` : 'Проверок пока нет';
  $('#monitorMessage').textContent = monitor.checking ? 'Проверяю сайты…' : monitor.message || when;
  $('#checkMonitorBtn').disabled = Boolean(monitor.checking);

  for (const container of [$('#homeServiceCards'), $('#monitorServiceCards')]) {
    container.textContent = '';
    const services = container.id === 'homeServiceCards'
      ? [['discord', 'Discord']]
      : [['youtube', 'YouTube'], ['discord', 'Discord'], ['google', 'Google · контроль']];
    for (const [id, label] of services) {
      const result = monitor.services?.[id];
      const card = makeElement('div', `service-card ${result ? result.ok ? 'service-ok' : 'service-fail' : 'service-unknown'}`);
      const availability = !result ? 'Не проверялся' : result.ok ? 'Доступен' : 'Недоступен';
      const latency = result?.ok && Number.isFinite(result.ms) ? `${Math.round(result.ms)} мс` : '— мс';
      const code = result?.code ? `, HTTP ${result.code}` : '';
      card.title = `${label}: ${availability}, задержка HTTPS: ${latency}${code}`;
      card.setAttribute('role', 'status');
      card.setAttribute('aria-label', card.title);

      const symbol = makeElement('span', 'service-symbol');
      symbol.append(
        makeElement('span', `service-logo service-logo-${id}`),
        makeElement('span', 'service-indicator')
      );
      const ping = makeElement('span', 'service-ping', latency);
      card.append(symbol, ping);
      container.appendChild(card);
    }
  }

  const ranking = $('#strategyRanking');
  ranking.textContent = '';
  const history = (state.strategyHistory || []).slice().sort((a, b) => b.total - a.total).slice(0, 12);
  if (!history.length) {
    ranking.appendChild(makeElement('p', 'micro-note', 'Ещё нет результатов. Запустите подбор на вкладке «Тесты».'));
  }
  for (const [index, entry] of history.entries()) {
    const row = makeElement('div', 'ranking-row');
    const name = makeElement('strong', '', `${index + 1}. ${entry.config}`);
    const signals = ['youtube', 'discord'].map((id) => `${id}: ${entry.services?.[id] === true ? '✓' : entry.services?.[id] === false ? '✕' : '?'}`).join(' · ');
    row.append(name, makeElement('span', '', signals), makeElement('b', '', `${entry.total} б.`));
    ranking.appendChild(row);
  }
}

async function refreshDiagnostics() {
  const button = $('#runDiagnosticsBtn');
  button.disabled = true;
  try {
    state.diagnostics = await window.zapret.runDiagnostics();
    renderDiagnostics();
  } catch (error) {
    showToast('error', error.message || String(error), { title: 'Диагностика' });
  } finally {
    button.disabled = false;
  }
}

function renderDiagnostics() {
  const container = $('#diagnosticsResults');
  if (!state || !state.diagnostics?.length) return;
  container.textContent = '';
  for (const entry of state.diagnostics) {
    const card = makeElement('section', `panel diagnostic-card diagnostic-${entry.level}`);
    const summary = makeElement('div', 'diagnostic-summary');
    const marker = entry.level === 'ok' ? '✓' : entry.level === 'error' ? '!' : entry.level === 'warning' ? '⚠' : 'i';
    summary.append(makeElement('span', 'diagnostic-marker', marker), makeElement('strong', '', entry.title));
    card.append(summary, makeElement('p', 'micro-note', entry.detail));
    if (entry.fixId) {
      const button = makeElement('button', 'ghost-button', entry.fixLabel || 'Исправить');
      button.addEventListener('click', async () => {
        if (!window.confirm(`Выполнить действие «${entry.fixLabel || 'Исправить'}»?`)) return;
        button.disabled = true;
        try {
          state.diagnostics = await window.zapret.fixDiagnostic(entry.fixId);
          await refreshState();
          showToast('success', 'Исправление выполнено', { title: 'Диагностика' });
        } catch (error) {
          button.disabled = false;
          showToast('error', error.message || String(error), { title: 'Исправление не удалось', duration: 9000 });
        }
      });
      card.appendChild(button);
    }
    container.appendChild(card);
  }
}

function refreshEditorChoices() {
  const select = $('#editorBaseConfig');
  const choices = state?.configs || [];
  const signature = choices.map((item) => item.name).join('|');
  if (select.dataset.signature === signature) return;
  const previous = select.value;
  select.textContent = '';
  for (const entry of choices) {
    const option = makeElement('option', '', entry.label);
    option.value = entry.name;
    select.appendChild(option);
  }
  if (choices.some((item) => item.name === previous)) select.value = previous;
  else if (choices.some((item) => item.name === state.settings.selectedConfig)) select.value = state.settings.selectedConfig;
  select.dataset.signature = signature;
}

async function initStrategyEditor() {
  if (!$('#editorName').value) $('#editorName').value = 'Моя стратегия';
  refreshEditorChoices();
  await loadStrategyEditor();
}

async function loadStrategyEditor() {
  const config = $('#editorBaseConfig').value;
  const requestId = ++editorLoadId;
  editorModel = null;
  $('#editorRules').textContent = '';
  if (!config) return;
  try {
    const next = await window.zapret.readStrategy(config);
    if (requestId !== editorLoadId) return;
    editorModel = next;
    renderEditorRules();
    scheduleEditorPreview();
  } catch (error) {
    $('#editorNotice').textContent = error.message || String(error);
  }
}

function editorPayload() {
  if (!editorModel) throw new Error('Сначала выберите конфиг');
  return {
    baseConfig: editorModel.config,
    name: $('#editorName').value,
    rules: editorModel.rules.map(({ index, ports, desync, repeats, fakeTls }) => ({ index, ports, desync, repeats, fakeTls }))
  };
}

function editorField(label, value, onInput, options = null, type = 'text') {
  const field = makeElement('label', 'editor-field');
  field.appendChild(makeElement('span', '', label));
  const input = makeElement(options ? 'select' : 'input');
  if (options) {
    for (const optionValue of options) {
      const option = makeElement('option', '', optionValue || 'Без TLS fake');
      option.value = optionValue;
      input.appendChild(option);
    }
  } else {
    input.type = type;
    if (type === 'number') {
      input.min = '1';
      input.max = '20';
    }
  }
  input.value = value ?? '';
  input.addEventListener(options ? 'change' : 'input', () => onInput(input.value));
  field.appendChild(input);
  return field;
}

function renderEditorRules() {
  const container = $('#editorRules');
  container.textContent = '';
  if (!editorModel) return;
  for (const rule of editorModel.rules) {
    const card = makeElement('section', 'panel editor-rule');
    const heading = makeElement('div', 'button-row');
    heading.append(makeElement('h2', '', `Правило ${rule.index + 1}`), makeElement('span', 'protocol-pill', rule.protocol));
    const controls = makeElement('div', 'editor-rule-grid');
    const update = (field) => (value) => { rule[field] = value; scheduleEditorPreview(); };
    controls.appendChild(editorField('Порты', rule.ports, update('ports')));
    controls.appendChild(editorField('DPI desync', rule.desync, update('desync')));
    controls.appendChild(editorField('Повторы', rule.repeats, update('repeats'), null, 'number'));
    if (rule.protocol === 'TCP') {
      const options = ['', ...editorModel.fakeFiles];
      if (rule.fakeTls && !options.includes(rule.fakeTls)) options.push(rule.fakeTls);
      controls.appendChild(editorField('TLS fake (bin)', rule.fakeTls, update('fakeTls'), options));
    }
    card.append(heading, controls);
    container.appendChild(card);
  }
}

function scheduleEditorPreview() {
  if (editorPreviewTimer) clearTimeout(editorPreviewTimer);
  editorPreviewTimer = setTimeout(refreshEditorPreview, 320);
}

async function refreshEditorPreview() {
  if (!editorModel) return;
  const requestId = ++editorPreviewId;
  try {
    const result = await window.zapret.previewStrategy(editorPayload());
    if (requestId !== editorPreviewId) return;
    $('#editorNotice').textContent = `Будет создан: ${result.filename}`;
    $('#editorPreview').textContent = result.preview;
  } catch (error) {
    if (requestId !== editorPreviewId) return;
    $('#editorNotice').textContent = `Ошибка: ${error.message || String(error)}`;
    $('#editorPreview').textContent = '';
  }
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
