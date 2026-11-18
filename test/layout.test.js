const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

test('power caption is outside the button stage and quick actions are separate', () => {
  const home = html.split('id="tab-home"')[1].split('id="tab-telegram"')[0];
  const stageStart = home.indexOf('<section class="power-stage"');
  const stageEnd = home.indexOf('</section>', stageStart);
  const captionStart = home.indexOf('<div class="power-caption"', stageStart);
  assert.ok(stageStart >= 0 && stageEnd >= 0 && captionStart > stageEnd);
  assert.match(home, /class="power-zone"/);
  assert.match(home, /class="home-quick-actions"/);
  assert.match(home, /id="checkUpdateBtn"[^>]*>[\s\S]*?<svg/);
  assert.match(home, /id="openReleaseBtn"[^>]*>[\s\S]*?<svg/);
  assert.doesNotMatch(home, /auto-panel/);
  assert.match(css, /\.power-caption\s*\{\s*position: relative/);
});

test('automation moved to settings, themes use a horizontal slider', () => {
  const settings = html.split('id="tab-settings"')[1];
  for (const id of ['launchAtLoginToggle', 'autoStartToggle', 'autoUpdateToggle', 'updateNotice']) {
    assert.match(settings, new RegExp(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  assert.match(settings, /id="themePrevBtn"/);
  assert.match(settings, /id="themeNextBtn"/);
  assert.match(css, /\.theme-grid\s*\{[^}]*overflow-x: auto/);
  assert.match(css, /\.home-dashboard\s*\{[^}]*min-height: calc\(100vh - 152px\)/);
});

test('application icon has an alpha channel and an ICO for Windows', () => {
  const png = fs.readFileSync(path.join(root, 'src/assets/app-icon.png'));
  const ico = fs.readFileSync(path.join(root, 'build/icon.ico'));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[25], 6); // RGBA
  assert.equal(ico.toString('hex', 0, 4), '00000100');
  assert.ok(ico.readUInt16LE(4) >= 5);
  assert.match(html, /\.\/assets\/app-icon\.svg/);
});
