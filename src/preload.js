const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('zapret', {
  getState: () => invoke('state:get'),
  hideWindow: () => invoke('window:hide'),
  relaunchAdmin: () => invoke('admin:relaunch'),
  openRoot: () => invoke('path:openRoot'),
  openLogs: () => invoke('path:openLogs'),

  start: (configName) => invoke('zapret:start', configName),
  stop: () => invoke('zapret:stop'),
  restart: (configName) => invoke('zapret:restart', configName),

  setSettings: (patch) => invoke('settings:set', patch),

  getGeneralList: () => invoke('lists:getGeneral'),
  addGeneralDomain: (domain) => invoke('lists:addGeneral', domain),
  removeGeneralDomain: (domain) => invoke('lists:removeGeneral', domain),
  saveGeneralDomains: (domains) => invoke('lists:saveGeneral', domains),

  readLogs: () => invoke('logs:read'),
  clearLogs: () => invoke('logs:clear'),

  checkUpdates: (options) => invoke('updates:check', options),
  openRelease: () => invoke('updates:openRelease'),
  checkAppUpdate: () => invoke('app-update:check'),
  installAppUpdate: () => invoke('app-update:install'),

  startTests: (options) => invoke('tests:start', options),
  cancelTests: () => invoke('tests:cancel'),

  installService: (configName) => invoke('service:install', configName),
  removeService: () => invoke('service:remove'),

  onState: (callback) => listen('state:update', callback),
  onLog: (callback) => listen('log:new', callback),
  onLogCleared: (callback) => listen('log:cleared', callback),
  onUpdateProgress: (callback) => listen('update:progress', callback),
  onAppUpdateProgress: (callback) => listen('app-update:progress', callback),
  onNotification: (callback) => listen('notification:push', callback),
  onTestsStart: (callback) => listen('tests:start', callback),
  onTestsProgress: (callback) => listen('tests:progress', callback),
  onTestsTarget: (callback) => listen('tests:target', callback),
  onTestsResult: (callback) => listen('tests:result', callback),
  onTestsDone: (callback) => listen('tests:done', callback),
  onTestsError: (callback) => listen('tests:error', callback)
});
