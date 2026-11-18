const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectWindowsReleaseAsset, compareReleaseVersions, telegramProxyLink, sha256File, TgwsProxyManager } = require('../src/tgws-proxy');

const digest = 'a'.repeat(64);
const release = {
  tag_name: 'v1.11.4',
  assets: [{
    name: 'TgWsProxy_windows.exe',
    browser_download_url: 'https://github.com/Flowseal/tg-ws-proxy/releases/download/v1.11.4/TgWsProxy_windows.exe',
    digest: `sha256:${digest}`
  }]
};

test('accepts an official Windows asset only when a SHA-256 is available', () => {
  assert.deepEqual(selectWindowsReleaseAsset(release), {
    url: release.assets[0].browser_download_url,
    sha256: digest,
    version: 'v1.11.4'
  });
});

test('rejects unofficial download URLs', () => {
  assert.throws(() => selectWindowsReleaseAsset({ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://malicious.example/evil.exe' }] }), /ссылк/i);
});

test('rejects missing or malformed release digests', () => {
  assert.throws(() => selectWindowsReleaseAsset({ ...release, assets: [{ ...release.assets[0], digest: '' }] }), /SHA-256/);
});

test('compares release tags numerically and does not downgrade', () => {
  assert.equal(compareReleaseVersions('v1.9.7', 'v1.11.4'), -1);
  assert.equal(compareReleaseVersions('v1.12.0', 'v1.11.4'), 1);
  assert.equal(compareReleaseVersions('v1.11.4', 'v1.11.4'), 0);
  assert.equal(compareReleaseVersions('—', 'v1.11.4'), -1);
});

test('builds the official Telegram deep link from a validated local config', () => {
  const secret = 'abcdef0123456789abcdef0123456789';
  assert.equal(telegramProxyLink({ host: '127.0.0.1', port: 1443, secret }),
    `tg://proxy?server=127.0.0.1&port=1443&secret=dd${secret}`);
  assert.equal(telegramProxyLink({ host: '0.0.0.0', port: 1443, secret }),
    `tg://proxy?server=127.0.0.1&port=1443&secret=dd${secret}`);
  assert.throws(() => telegramProxyLink({ host: '127.0.0.1', port: -1, secret }), /порт/);
  assert.throws(() => telegramProxyLink({ host: 'evil.example', port: 1443, secret }), /адрес/);
  assert.throws(() => telegramProxyLink({ host: '127.0.0.1', port: 1443, secret: 'invalid' }), /ключ/);
});

test('calculates the actual file digest without loading the whole binary into memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgws-test-'));
  const file = path.join(dir, 'binary.exe');
  try {
    const contents = Buffer.from('test proxy binary');
    fs.writeFileSync(file, contents);
    assert.equal(await sha256File(file), createHash('sha256').update(contents).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installs the verified official binary and reports a stable 100% state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgws-install-test-'));
  const bytes = Buffer.from('official test binary');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const notifications = [];
  const manager = new TgwsProxyManager({
    platform: 'win32',
    getUserData: () => dir,
    fetchJson: async () => ({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${checksum}` }] }),
    downloadFile: async (_url, target, _redirects, onProgress) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      onProgress(bytes.length, bytes.length);
    },
    notify: (progress) => notifications.push(progress),
    log: () => {}
  });
  try {
    const result = await manager.install({ startAfter: false });
    assert.equal(result.installed, true);
    assert.equal(result.version, 'v1.11.4');
    assert.equal(result.progress, 100);
    assert.equal(result.busy, false);
    assert.ok(notifications.some((entry) => entry.busy && entry.progress === 99));
    assert.deepEqual(fs.readFileSync(manager.executable), bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checksum mismatch cannot replace an installed TGWS binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgws-integrity-test-'));
  const manager = new TgwsProxyManager({
    platform: 'win32',
    getUserData: () => dir,
    fetchJson: async () => release,
    downloadFile: async (_url, target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'unverified bytes');
    },
    notify: () => {},
    log: () => {}
  });
  try {
    fs.mkdirSync(manager.directory, { recursive: true });
    fs.writeFileSync(manager.executable, 'previous known-good binary');
    await assert.rejects(manager.install({ startAfter: false }), /Контрольная сумма/);
    assert.equal(fs.readFileSync(manager.executable, 'utf8'), 'previous known-good binary');
    assert.equal(fs.existsSync(`${manager.executable}.download`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reads the saved portable proxy secret for Telegram instead of inventing a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgws-link-test-'));
  const manager = new TgwsProxyManager({ platform: 'win32', getUserData: () => dir,
    fetchJson: async () => release, downloadFile: async () => {}, notify: () => {}, log: () => {} });
  try {
    fs.mkdirSync(path.dirname(manager.configFile), { recursive: true });
    fs.writeFileSync(manager.executable, 'installed binary');
    assert.throws(() => manager.getTelegramLink(), /Настройки/);
    fs.writeFileSync(manager.configFile, JSON.stringify({ host: '127.0.0.1', port: 1443, secret: 'd'.repeat(32) }));
    assert.match(manager.getTelegramLink(), /^tg:\/\/proxy\?server=127\.0\.0\.1&port=1443&secret=dd[d]{32}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checks updates, replaces an existing verified exe and preserves the portable config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgws-update-test-'));
  const bytes = Buffer.from('official updated binary');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;
  const manager = new TgwsProxyManager({
    platform: 'win32', getUserData: () => dir,
    fetchJson: async () => ({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${checksum}` }] }),
    downloadFile: async (_url, target) => { downloads++; fs.writeFileSync(target, bytes); },
    notify: () => {}, log: () => {}
  });
  try {
    fs.mkdirSync(path.dirname(manager.configFile), { recursive: true });
    fs.writeFileSync(manager.executable, 'old exe');
    fs.writeFileSync(manager.manifestFile, JSON.stringify({ version: 'v1.9.0' }));
    fs.writeFileSync(manager.configFile, JSON.stringify({ host: '127.0.0.1', port: 1443, secret: 'a'.repeat(32) }));
    const found = await manager.checkForUpdate();
    assert.equal(found.updateAvailable, true);
    assert.equal(found.latestVersion, 'v1.11.4');
    const installed = await manager.update({ automatic: true });
    assert.equal(installed.version, 'v1.11.4');
    assert.equal(installed.updateAvailable, false);
    assert.equal(downloads, 1);
    assert.deepEqual(fs.readFileSync(manager.executable), bytes);
    assert.equal(fs.existsSync(`${manager.executable}.previous`), false);
    assert.match(manager.getTelegramLink(), /secret=dd[a]{32}$/);
    await manager.update({ automatic: true });
    assert.equal(downloads, 1, 'same version must not be downloaded twice');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
