const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { filesAreEqual, copyFileIfDifferent, copyDirFiltered } = require('../src/update-files');

test('an identical loaded WinDivert driver is not copied again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-driver-copy-'));
  try {
    const original = path.join(dir, 'source.sys');
    const installed = path.join(dir, 'WinDivert64.sys');
    fs.writeFileSync(original, 'the same signed driver');
    fs.writeFileSync(installed, 'the same signed driver');
    let attempted = false;
    const copy = fs.copyFileSync;
    fs.copyFileSync = () => { attempted = true; throw Object.assign(new Error('file locked'), { code: 'EBUSY' }); };
    try {
      assert.equal(filesAreEqual(original, installed), true);
      assert.equal(copyFileIfDifferent(original, installed), false);
      assert.equal(attempted, false);
      fs.writeFileSync(original, 'a different signed driver');
      assert.throws(() => copyFileIfDifferent(original, installed), { code: 'EBUSY' });
      assert.equal(fs.readFileSync(installed, 'utf8'), 'the same signed driver');
    } finally {
      fs.copyFileSync = copy;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('directory update preserves unchanged binaries and skips user flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-update-files-'));
  try {
    const from = path.join(dir, 'from');
    const to = path.join(dir, 'to');
    fs.mkdirSync(from); fs.mkdirSync(to);
    fs.writeFileSync(path.join(from, 'winws.exe'), 'new');
    fs.writeFileSync(path.join(from, 'game_filter.enabled'), 'all');
    fs.writeFileSync(path.join(to, 'winws.exe'), 'old');
    fs.writeFileSync(path.join(to, 'game_filter.enabled'), 'disabled');
    copyDirFiltered(from, to, name => !/\.enabled$/i.test(name));
    assert.equal(fs.readFileSync(path.join(to, 'winws.exe'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(to, 'game_filter.enabled'), 'utf8'), 'disabled');
    assert.equal(copyFileIfDifferent(path.join(from, 'winws.exe'), path.join(to, 'winws.exe')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('version marker is copied only after the driver and all other payloads', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('function applyUpdateFiles('), main.indexOf('function mergeListsDirectory('));
  assert.ok(block.indexOf('copyFileIfDifferent(driverSource') > 0);
  assert.ok(block.indexOf('copyDirFiltered(') > block.indexOf('copyFileIfDifferent(driverSource'));
  assert.ok(block.indexOf('copyFileIfDifferent(serviceSource') > block.indexOf('copyDirFiltered('));
});
