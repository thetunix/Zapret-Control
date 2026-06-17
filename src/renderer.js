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

  $('#installServiceBtn').addEventListener('click', async () => action(() => window.zapret.installService($('#configSelect').value)));
  $('#removeServiceBtn').addEventListener('click', async () => action(() => window.zapret.removeService()));

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
  $('#serviceState').textContent = state.service.installed ? state.service.state : 'нет';
  $('#versionState').textContent = state.versions.local || 'n/a';
  $('#adminLabel').textContent = state.admin ? 'Админ: да' : 'Админ: нет';
  $('#serviceNotice').textContent = state.service.installed ? `Служба: ${state.service.state}` : 'Служба не установлена';

  renderConfigSelect();
  renderSettings();
  renderUpdate();
  renderThemes();
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
  $('#updateNotice').textContent = update.message || '...';
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

async function action(fn) {
  try {
    const result = await fn();
    if (result && typeof result === 'object' && result.settings) {
      state = result;
      renderState();
    }
  } catch (error) {
    alert(error.message || String(error));
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
