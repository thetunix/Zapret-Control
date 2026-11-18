// A small manager for the official, separately distributed Flowseal TG WS Proxy.
// No executable is fetched until the user explicitly chooses to install it.
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TGWS_REPO = 'Flowseal/tg-ws-proxy';
const TGWS_RELEASE_API = `https://api.github.com/repos/${TGWS_REPO}/releases/latest`;
const TGWS_RELEASES_URL = `https://github.com/${TGWS_REPO}/releases`;
const TGWS_EXE_NAME = 'TgWsProxy_windows.exe';

function selectWindowsReleaseAsset(release) {
  const asset = release?.assets?.find((entry) => entry.name === TGWS_EXE_NAME);
  if (!asset) throw new Error('В официальном релизе TG WS Proxy нет Windows x64 сборки');

  const url = String(asset.browser_download_url || '');
  const expectedPrefix = `https://github.com/${TGWS_REPO}/releases/download/`;
  if (!url.startsWith(expectedPrefix) || !url.endsWith(`/${TGWS_EXE_NAME}`)) {
    throw new Error('Некорректная ссылка на официальный TG WS Proxy');
  }

  // GitHub publishes the SHA-256 alongside release assets. Refuse an unverified download.
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
  if (!digest) throw new Error('В релизе TG WS Proxy отсутствует SHA-256 для проверки файла');

  return { url, sha256: digest[1].toLowerCase(), version: String(release.tag_name || '—') };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class TgwsProxyManager {
  constructor({ getUserData, fetchJson, downloadFile, notify, log, platform = process.platform }) {
    this.getUserData = getUserData;
    this.fetchJson = fetchJson;
    this.downloadFile = downloadFile;
    this.notify = notify;
    this.log = log;
    this.platform = platform;
    this.child = null;
    this.busy = false;
    this.progress = 0;
    this.message = '';
    this.externalCheckedAt = 0;
    this.externalRunning = false;
  }

  get directory() { return path.join(this.getUserData(), 'tgws-proxy'); }
  get executable() { return path.join(this.directory, TGWS_EXE_NAME); }
  get manifestFile() { return path.join(this.directory, 'release.json'); }

  get installed() { return fs.existsSync(this.executable); }

  get localVersion() {
    try { return JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')).version || '—'; }
    catch { return '—'; }
  }

  async status() {
    const runningManaged = Boolean(this.child && this.child.exitCode === null && !this.child.killed);
    let running = runningManaged;
    if (this.platform === 'win32' && this.installed && Date.now() - this.externalCheckedAt > 4500) {
      try {
        const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${TGWS_EXE_NAME}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true });
        this.externalRunning = stdout.toLowerCase().includes(`"${TGWS_EXE_NAME.toLowerCase()}"`);
      } catch { /* process inspection may be restricted; managed state still works */ }
      this.externalCheckedAt = Date.now();
    }
    running ||= this.externalRunning;

    return {
      installed: this.installed,
      running,
      managed: runningManaged,
      busy: this.busy,
      progress: this.progress,
      version: this.localVersion,
      message: this.message
    };
  }

  async broadcast() { this.notify(await this.status()); }

  async install({ startAfter = true } = {}) {
    if (this.platform !== 'win32') throw new Error('TG WS Proxy поддерживается только на Windows');
    if (this.busy) throw new Error('Загрузка TG WS Proxy уже выполняется');
    if ((await this.status()).running) throw new Error('Сначала остановите TG WS Proxy через системный трей');

    this.busy = true;
    this.progress = 0;
    this.message = 'Проверяю официальный релиз Flowseal…';
    await this.broadcast();
    const partPath = `${this.executable}.download`;

    try {
      const asset = selectWindowsReleaseAsset(await this.fetchJson(TGWS_RELEASE_API));
      this.message = 'Скачиваю официальную Windows-сборку…';
      await this.broadcast();
      await this.downloadFile(asset.url, partPath, 0, (loaded, total) => {
        if (total > 0) {
          // Hold at 99% until checksum verification and atomic file replacement finish.
          this.progress = Math.max(this.progress, Math.min(99, Math.floor(loaded * 100 / total)));
          this.notify({ installed: this.installed, running: false, managed: false, busy: true,
            progress: this.progress, version: this.localVersion, message: this.message });
        }
      });
      this.message = 'Проверяю SHA-256…';
      await this.broadcast();
      if ((await sha256File(partPath)) !== asset.sha256) {
        throw new Error('Контрольная сумма TG WS Proxy не совпадает. Файл не установлен');
      }
      fs.renameSync(partPath, this.executable);
      fs.writeFileSync(this.manifestFile, JSON.stringify({ version: asset.version, sha256: asset.sha256 }, null, 2));
      this.progress = 100;
      this.message = 'Установлено из официального релиза Flowseal';
      this.log(`TG WS Proxy ${asset.version} установлен (SHA-256 подтверждён)`);
    } catch (error) {
      this.message = `Не удалось установить TG WS Proxy: ${error.message}`;
      this.log(this.message, 'error');
      throw error;
    } finally {
      try { fs.rmSync(partPath, { force: true }); } catch {}
      this.busy = false;
      await this.broadcast();
    }

    if (startAfter) return this.start();
    return this.status();
  }

  async start() {
    if (this.platform !== 'win32') throw new Error('TG WS Proxy поддерживается только на Windows');
    if (!this.installed) throw new Error('Сначала установите TG WS Proxy');
    if ((await this.status()).running) return this.status();

    const child = spawn(this.executable, ['--portable'], {
      cwd: this.directory, windowsHide: false, stdio: 'ignore', detached: false
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // Telegram's tray process must not keep Control Center from exiting.
    child.unref();
    this.child = child;
    this.externalRunning = true;
    this.externalCheckedAt = Date.now();
    this.message = 'Прокси запущен · подключите его в трее к Telegram';
    child.on('error', (error) => this.log(`TG WS Proxy: ${error.message}`, 'error'));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      this.externalCheckedAt = 0;
      this.message = 'TG WS Proxy остановлен';
      this.broadcast().catch(() => {});
    });
    this.log('TG WS Proxy запущен');
    await this.broadcast();
    return this.status();
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error('TG WS Proxy запущен отдельно. Остановите его через значок в трее');
    }
    const child = this.child;
    if (this.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 6000, windowsHide: true });
      } catch {
        child.kill();
      }
    } else child.kill();
    this.child = null;
    this.externalRunning = false;
    this.externalCheckedAt = 0;
    this.message = 'TG WS Proxy остановлен';
    this.log('TG WS Proxy остановлен');
    await this.broadcast();
    return this.status();
  }
}

module.exports = { TGWS_RELEASES_URL, selectWindowsReleaseAsset, sha256File, TgwsProxyManager };
