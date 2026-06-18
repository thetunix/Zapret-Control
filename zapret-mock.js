// Demo backend for the Zapret Control Center website preview.
// Implements the same window.zapret API surface as the Electron preload,
// fully in-memory, so the real renderer.js runs UNMODIFIED on the website.
(function () {
  const listeners = {};
  const on = (event, cb) => {
    (listeners[event] = listeners[event] || []).push(cb);
    return () => {
      listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
    };
  };
  const emit = (event, payload) => {
    (listeners[event] || []).forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        console.error(e);
      }
    });
  };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const configNames = [
    'general',
    'general (ALT)',
    'general (ALT2)',
    'general (ALT3)',
    'general (ALT4)',
    'general (FAKE TLS)',
    'general (FAKE TLS AUTO)',
    'general (FAKE TLS MOD)',
    'general (SIMPLE FAKE)',
    'general (SIMPLE FAKE 2)',
    'general (FAKE 3)',
    'general (MGTS)',
    'general (MGTS2)',
    'general (RU)',
    'general (DISCORD)',
    'general (YOUTUBE)',
    'general (ALT5)'
  ];

  const baseDomains = [
    'discord.com',
    'discord.gg',
    'discordapp.com',
    'discordapp.net',
    'discord.media',
    'gateway.discord.gg',
    'cdn.discordapp.com',
    'media.discordapp.net',
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
    'youtubei.googleapis.com',
    'googlevideo.com',
    'ytimg.com',
    'ggpht.com',
    'jnn-pa.googleapis.com',
    'play.google.com',
    'gvt1.com'
  ];

  let userDomains = ['my-blocked-site.com', 'rutracker.org', 'example.org'];
  let testRun = 0; // bump to cancel an in-flight test run

  const state = {
    admin: true,
    rootDir: 'C:\\Program Files\\Zapret Control Center',
    configs: configNames.map((name) => ({ name, label: name })),
    settings: {
      theme: 'figma',
      selectedConfig: 'general (ALT)',
      bestConfig: 'general (ALT)',
      launchAtLogin: true,
      autoStartZapret: true,
      autoUpdateZapret: true,
      testMode: 'fast',
      ambientIntensity: 72,
      glassBlur: 18,
      motionSpeed: 55,
      gameFilterMode: 'all'
    },
    running: { active: false, externalCount: 0, managedCount: 0, processes: [] },
    service: { installed: false, state: 'stopped' },
    versions: { local: '70' },
    update: { message: 'Установлена актуальная версия 1.9.9c' },
    logs: []
  };

  function log(type, message) {
    const entry = { time: Date.now(), type, message };
    state.logs.push(entry);
    state.logs = state.logs.slice(-500);
    emit('log:new', entry);
  }

  [
    ['info', 'Инициализация Zapret Control Center'],
    ['ok', 'Права администратора получены'],
    ['info', 'Загружено 17 конфигураций'],
    ['info', 'Список доменов синхронизирован']
  ].forEach(([t, m]) => log(t, m));

  const snapshot = () => JSON.parse(JSON.stringify(state));

  function setRunning(active) {
    state.running = active
      ? { active: true, externalCount: 0, managedCount: 1, processes: [{ pid: 5120 }] }
      : { active: false, externalCount: 0, managedCount: 0, processes: [] };
  }

  window.zapret = {
    getState: async () => snapshot(),
    hideWindow: async () => {
      log('info', 'Свёрнуто в трей (демо)');
    },
    relaunchAdmin: async () => {
      log('info', 'Перезапуск с правами администратора (демо)');
      return snapshot();
    },
    openRoot: async () => {
      log('info', 'Открыта папка программы (демо)');
    },
    openLogs: async () => {
      log('info', 'Открыта папка логов (демо)');
    },

    start: async (configName) => {
      const cfg = configName || state.settings.selectedConfig;
      state.settings.selectedConfig = cfg;
      log('info', `Запуск winws.exe — ${cfg}`);
      await delay(450);
      setRunning(true);
      log('ok', 'Сервис запущен');
      return snapshot();
    },
    stop: async () => {
      log('info', 'Остановка winws.exe');
      await delay(300);
      setRunning(false);
      log('ok', 'Сервис остановлен');
      return snapshot();
    },
    restart: async (configName) => {
      const cfg = configName || state.settings.selectedConfig;
      log('info', `Перезапуск — ${cfg}`);
      await delay(500);
      setRunning(true);
      log('ok', 'Перезапущено');
      return snapshot();
    },

    setSettings: async (patch) => {
      Object.assign(state.settings, patch || {});
      return snapshot();
    },

    getGeneralList: async () => ({ user: userDomains.slice(), base: baseDomains.slice() }),
    addGeneralDomain: async (domain) => {
      const d = String(domain || '').trim();
      if (d && !userDomains.includes(d)) {
        userDomains.push(d);
        log('ok', `Добавлен домен: ${d}`);
      }
      return snapshot();
    },
    removeGeneralDomain: async (domain) => {
      userDomains = userDomains.filter((d) => d !== domain);
      return snapshot();
    },
    saveGeneralDomains: async (domains) => {
      userDomains = (domains || []).slice();
      log('ok', `Сохранено доменов: ${userDomains.length}`);
      return snapshot();
    },

    readLogs: async () =>
      state.logs
        .map((e) => `[${new Date(e.time).toLocaleTimeString('ru-RU')}] ${e.message}`)
        .join('\n'),
    clearLogs: async () => {
      state.logs = [];
      emit('log:cleared');
      log('info', 'Логи очищены');
    },

    checkUpdates: async () => {
      log('info', 'Проверка обновлений с GitHub…');
      emit('update:progress', { message: 'Проверка обновлений…' });
      await delay(900);
      const msg = 'Установлена актуальная версия 1.9.9c';
      emit('update:progress', { message: msg });
      state.update = { message: msg };
      log('ok', 'Обновлений не найдено — установлена последняя версия');
      return snapshot();
    },
    openRelease: async () => {
      window.open('https://github.com/thetunix/Zapret-Control/releases/latest', '_blank', 'noopener');
    },

    startTests: async (options) => {
      const myRun = ++testRun;
      const mode = (options && options.mode) || state.settings.testMode || 'fast';
      const list = mode === 'fast' ? state.configs.slice(0, 10) : state.configs.slice();
      const targets = mode === 'fast' ? 2 : 4;
      emit('tests:start', { total: list.length, targets });
      let best = null;
      for (let i = 0; i < list.length; i++) {
        if (myRun !== testRun) {
          emit('tests:done', { best, cancelled: true });
          return snapshot();
        }
        const cfg = list[i].name;
        emit('tests:progress', { config: cfg, index: i, total: list.length });
        for (let t = 0; t < targets; t++) {
          if (myRun !== testRun) {
            emit('tests:done', { best, cancelled: true });
            return snapshot();
          }
          emit('tests:target', {
            config: cfg,
            target: baseDomains[t % baseDomains.length],
            targetIndex: t,
            totalTargets: targets
          });
          await delay(mode === 'fast' ? 110 : 90);
        }
        const ok = Math.floor(Math.random() * (targets + 1));
        const fail = targets - ok;
        const result = { config: cfg, score: { total: ok * 100 - fail * 20, ok, fail, pingOk: ok } };
        if (!best || result.score.total > best.score.total) best = result;
        emit('tests:result', result);
      }
      if (best) {
        state.settings.bestConfig = best.config;
        state.settings.selectedConfig = best.config;
      }
      log('ok', best ? `Лучший конфиг: ${best.config}` : 'Тест завершён');
      emit('tests:done', { best, cancelled: false });
      return snapshot();
    },
    cancelTests: async () => {
      testRun++;
      log('info', 'Тестирование остановлено');
    },

    installService: async (configName) => {
      state.service = { installed: true, state: 'running' };
      log('ok', `Служба установлена (${configName || state.settings.selectedConfig})`);
      return snapshot();
    },
    removeService: async () => {
      state.service = { installed: false, state: 'stopped' };
      log('info', 'Служба удалена');
      return snapshot();
    },

    onState: (cb) => on('state:update', cb),
    onLog: (cb) => on('log:new', cb),
    onLogCleared: (cb) => on('log:cleared', cb),
    onUpdateProgress: (cb) => on('update:progress', cb),
    onTestsStart: (cb) => on('tests:start', cb),
    onTestsProgress: (cb) => on('tests:progress', cb),
    onTestsTarget: (cb) => on('tests:target', cb),
    onTestsResult: (cb) => on('tests:result', cb),
    onTestsDone: (cb) => on('tests:done', cb),
    onTestsError: (cb) => on('tests:error', cb)
  };
})();
