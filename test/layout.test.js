const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');

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

test('home layout keeps the power control above a centered status and service row', () => {
  const home = html.split('id="tab-home"')[1].split('id="tab-telegram"')[0];
  const stage = home.indexOf('class="power-stage"');
  const bottom = home.indexOf('class="home-bottom"');
  const statusCard = home.indexOf('class="status-block"');
  const middle = home.indexOf('class="home-center-stack"');
  const caption = home.indexOf('class="power-caption"');
  const serviceCards = home.indexOf('id="homeServiceCards"');
  const logs = home.indexOf('class="panel logs-panel"');
  assert.ok(stage >= 0 && bottom > stage && statusCard > bottom && middle > statusCard);
  assert.ok(caption > middle && serviceCards > caption && logs > serviceCards);
  assert.equal(home.split('id="powerStateLabel"').length - 1, 1);
  assert.match(css, /\.home-dashboard\s*\{[^}]*grid-template-rows:/);
  assert.match(css, /\.home-bottom\s*\{[^}]*grid-template-columns: minmax\(220px, 300px\) minmax\(220px, 1fr\) minmax\(220px, 300px\)/);
});

test('power eyebrow clears the outer halo and identical error notices do not stack', () => {
  const eyebrow = css.match(/\.power-stage \.power-eyebrow\s*\{([^}]+)\}/)?.[1];
  assert.ok(eyebrow);
  const offset = Number(eyebrow.match(/top:\s*(-?\d+)px/)?.[1]);
  assert.ok(offset <= -60, `expected label clear of halo, got ${offset}px`);
  assert.match(renderer, /node\.dataset\.toastKey === toastKey/);
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

test('Telegram proxy provides direct connection and separate update controls', () => {
  const telegram = html.split('id="tab-telegram"')[1].split('id="tab-tests"')[0];
  for (const id of ['tgwsConnectBtn', 'tgwsCopyBtn', 'tgwsCheckUpdateBtn', 'tgwsUpdateBtn']) {
    assert.match(telegram, new RegExp(`id="${id}"`));
  }
  assert.match(telegram, /Подключить Telegram/);
  assert.match(css, /\.tgws-connect-button\s*\{/);
  assert.match(css, /\.tgws-update-row\[hidden\]/);
});
