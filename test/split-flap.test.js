const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const begin = renderer.indexOf('function flipText(');
const end = renderer.indexOf('\nfunction renderConnectionState()', begin);

function fakeElement(text = '') {
  const classes = new Set();
  const attributes = {};
  return {
    textContent: text,
    dataset: {},
    children: [],
    className: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
    getAttribute: (name) => attributes[name],
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
  };
}

test('status switches create hinged split-flap halves and settle on new text', () => {
  assert.ok(begin !== -1 && end > begin);
  const timers = [];
  const flipText = new Function('document', 'window', 'flipTimers', 'setTimeout', 'clearTimeout',
    `${renderer.slice(begin, end)}\nreturn flipText;`)(
    { createElement: () => fakeElement() },
    { matchMedia: () => ({ matches: false }) },
    new WeakMap(),
    (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    () => {}
  );
  const label = fakeElement('Отключено');
  label.dataset.displayedText = 'Отключено';

  flipText(label, 'Подключение…');
  assert.equal(label.classList.contains('split-flap-active'), true);
  assert.equal(label.getAttribute('aria-label'), 'Подключение…');
  assert.deepEqual(label.children.map((node) => node.className), [
    'split-flap-half split-flap-new split-flap-top',
    'split-flap-half split-flap-old split-flap-bottom',
    'split-flap-half split-flap-old split-flap-top',
    'split-flap-half split-flap-new split-flap-bottom'
  ]);
  assert.deepEqual(label.children.map((node) => node.children[0].textContent), [
    'Подключение…', 'Отключено', 'Отключено', 'Подключение…'
  ]);
  assert.equal(timers[0].delay, 600);

  timers[0].callback();
  assert.equal(label.textContent, 'Подключение…');
  assert.equal(label.classList.contains('split-flap-active'), false);
  assert.equal(label.getAttribute('aria-label'), undefined);

  flipText(label, 'Подключено');
  assert.equal(label.dataset.displayedText, 'Подключено');
  timers[1].callback();
  assert.equal(label.textContent, 'Подключено');
});

test('split-flap has two staggered 3D folds and a reduced-motion fallback', () => {
  assert.match(styles, /@keyframes splitFlapFold/);
  assert.match(styles, /@keyframes splitFlapUnfold/);
  assert.match(styles, /\.split-flap-new-bottom\s*\{[^}]*280ms 280ms/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /\.sliding-next\s*\{/);
});
