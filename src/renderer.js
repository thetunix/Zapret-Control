const themes = [
  { id: 'figma', name: 'Figma Dark', hint: 'violet glass' },
  { id: 'aurora', name: 'Aurora', hint: 'teal amber' },
  { id: 'graphite', name: 'Graphite', hint: 'neutral lime' },
  { id: 'ember', name: 'Ember', hint: 'warm blue' },
  { id: 'glacier', name: 'Glacier', hint: 'ice violet' },
  { id: 'orchid', name: 'Orchid', hint: 'soft purple' },
  { id: 'forest', name: 'Forest', hint: 'green gold' },
  { id: 'ruby', name: 'Ruby', hint: 'rose cyan' },
  { id: 'noir', name: 'Noir', hint: 'mono mint' }
];

let state = null;
let logs = [];
let testRunning = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindControls();
  renderThemes();
  await refreshState();
  await refreshGeneralList();
  await refreshLogs();
  setInterval(refreshState, 3000);
});

window.zapret.onState((nextState) => {
  state = nextState;
  renderState();
});

window.zapret.onLog((entry) => {
  logs.push(entry);
  logs = logs.slice(-500);
  renderLogs();
});

window.zapret.onLogCleared(() => {
  logs = [];
  renderLogs();
});

window.zapret.onUpdateProgress((update) => {
  if (!state) return;
  state.update = update;
  renderUpdate();
});

window.zapret.onAppUpdateProgress((appUpdate) => {
  if (!state) return;
  state.appUpdate = appUpdate;
  renderAppUpdateBanner();
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

function bindTabs() {
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.nav-item').forEach((item) => item.classList.remove('active'));
      $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      $(`#tab-${button.dataset.tab}`).classList.add('active');
      if (button.dataset.tab === 'logs') refreshLogs();
    });
  });
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
  $('#autoStartToggle').addEventListener('change', (event) => patchSetting({ autoStartZapret: event.target.checked }));
  $('#autoUpdateToggle').addEventListener('change', (event) => patchSetting({ autoUpdateZapret: event.target.checked }));
  $('#checkUpdateBtn').addEventListener('click', async () => action(() => window.zapret.checkUpdates({ apply: true })));
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

  $('#gameFilterGroup').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    await patchSetting({ gameFilterMode: button.dataset.mode });
  });
}

async function refreshState() {
  state = await window.zapret.getState();
  logs = state.logs || logs;
  renderState();
  renderLogs();
}

function renderState() {
  if (!state) return;

  document.body.dataset.theme = state.settings.theme || 'aurora';
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
  renderThemes();
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
  const current = select.value;
  const selected = state.settings.selectedConfig || state.settings.bestConfig;
  select.innerHTML = '';
  for (const config of state.configs) {
    const option = document.createElement('option');
    option.value = config.name;
    option.textContent = config.label;
    select.appendChild(option);
  }
  select.value = current && state.configs.some((item) => item.name === current) ? current : selected;
}

function renderSettings() {
  $('#launchAtLoginToggle').checked = Boolean(state.settings.launchAtLogin);
  $('#autoStartToggle').checked = Boolean(state.settings.autoStartZapret);
  $('#autoUpdateToggle').checked = Boolean(state.settings.autoUpdateZapret);
  $('#testModeSelect').value = state.settings.testMode || 'fast';
  $('#ambientIntensityRange').value = state.settings.ambientIntensity ?? 72;
  $('#glassBlurRange').value = state.settings.glassBlur ?? 18;
  $('#motionSpeedRange').value = state.settings.motionSpeed ?? 55;
  updateRangeLabels();

  $$('#gameFilterGroup button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.settings.gameFilterMode);
  });
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

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}${options.action ? ' toast-actionable' : ''}`;

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

function renderThemes() {
  const grid = $('#themeGrid');
  if (!grid) return;
  const active = state?.settings?.theme || document.body.dataset.theme || 'aurora';
  grid.innerHTML = '';

  for (const theme of themes) {
    const button = document.createElement('button');
    button.className = `theme-swatch theme-${theme.id}`;
    button.dataset.theme = theme.id;
    button.innerHTML = `<span></span><strong>${theme.name}</strong><small>${theme.hint}</small>`;
    button.classList.toggle('active', theme.id === active);
    button.addEventListener('click', async () => {
      document.body.dataset.theme = theme.id;
      await patchSetting({ theme: theme.id });
    });
    grid.appendChild(button);
  }
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
  preview.innerHTML = '';
  logs.slice(-120).forEach((entry) => {
    const row = document.createElement('div');
    row.className = `log-row ${entry.type}`;
    row.textContent = `${formatTime(entry.time)} ${entry.message}`;
    preview.appendChild(row);
  });
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
