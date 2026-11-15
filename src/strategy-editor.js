// Pure helpers for the visual strategy editor. Keep the original batch preamble,
// variable expansion and all unrelated winws options intact.
const RULE_RE = /--filter-(tcp|udp)=([^\s^]+)/i;
const DESYNC_RE = /^[a-z][a-z0-9,-]{0,63}$/i;

function readFlag(line, name) {
  const match = line.match(new RegExp(`(?:^|\\s)--${name}=("[^"]*"|[^\\s^]+)`, 'i'));
  return match ? match[1].replace(/^"|"$/g, '') : '';
}

function describeStrategy(source) {
  if (typeof source !== 'string' || !/winws\.exe/i.test(source)) {
    throw new Error('В стратегии не найден запуск winws.exe');
  }
  const lines = source.split(/\r?\n/);
  const rules = [];
  lines.forEach((line, lineIndex) => {
    const filter = line.match(RULE_RE);
    if (!filter) return;
    const fake = readFlag(line, 'dpi-desync-fake-tls');
    rules.push({
      index: rules.length,
      lineIndex,
      protocol: filter[1].toUpperCase(),
      ports: filter[2],
      desync: readFlag(line, 'dpi-desync'),
      repeats: readFlag(line, 'dpi-desync-repeats'),
      fakeTls: /(?:^|[\\/])([^\\/]+\.bin)$/i.exec(fake.replace(/^%BIN%/i, ''))?.[1] || ''
    });
  });
  if (!rules.length) throw new Error('В стратегии не найдены правила TCP/UDP');
  return rules;
}

function validatePorts(value, protocol) {
  const parts = String(value).split(',');
  if (!parts.length || parts.length > 50) throw new Error('Слишком длинный список портов');
  for (const part of parts) {
    if (part === `%GameFilter${protocol}%`) continue;
    if (!/^\d{1,5}(?:-\d{1,5})?$/.test(part)) throw new Error(`Неверный порт: ${part}`);
    const [from, to = from] = part.split('-').map(Number);
    if (from < 1 || to > 65535 || from > to) throw new Error(`Неверный диапазон: ${part}`);
  }
  return parts.join(',');
}

function setFlag(line, name, value) {
  const pattern = new RegExp(`(^|\\s)--${name}=("[^"]*"|[^\\s^]+)`, 'gi');
  if (!value) return line.replace(pattern, '$1').replace(/ {2,}/g, ' ');
  if (pattern.test(line)) {
    pattern.lastIndex = 0;
    return line.replace(pattern, (_match, whitespace) => `${whitespace}--${name}=${value}`);
  }
  if (/\s--new(?:\s|$)/i.test(line)) return line.replace(/\s--new/i, ` --${name}=${value} --new`);
  if (/\s\^\s*$/.test(line)) return line.replace(/\s\^\s*$/, ` --${name}=${value} ^`);
  return `${line} --${name}=${value}`;
}

function buildStrategy(source, edits, fakeFiles = []) {
  const rules = describeStrategy(source);
  if (!Array.isArray(edits) || edits.length !== rules.length) {
    throw new Error('Количество правил изменилось. Загрузите стратегию заново.');
  }
  const allowedFakes = new Set(fakeFiles);
  const lines = source.split(/\r?\n/);
  for (const rule of rules) {
    const edit = edits[rule.index];
    if (!edit || edit.index !== rule.index) throw new Error('Неправильный порядок правил');
    const ports = validatePorts(edit.ports, rule.protocol);
    const desync = String(edit.desync || '').trim();
    if (desync && !DESYNC_RE.test(desync)) throw new Error('Неверное значение DPI desync');
    const repeats = String(edit.repeats ?? '').trim();
    if (repeats && (!/^\d{1,2}$/.test(repeats) || +repeats < 1 || +repeats > 20)) {
      throw new Error('Число повторов должно быть от 1 до 20');
    }
    const fakeTls = String(edit.fakeTls || '');
    if (fakeTls && (rule.protocol !== 'TCP' || !allowedFakes.has(fakeTls) || !/^[\w.-]+\.bin$/i.test(fakeTls))) {
      throw new Error('Выберите существующий TLS-файл из списка');
    }

    let line = lines[rule.lineIndex];
    line = line.replace(RULE_RE, `--filter-${rule.protocol.toLowerCase()}=${ports}`);
    if (desync !== rule.desync) line = setFlag(line, 'dpi-desync', desync);
    if (repeats !== rule.repeats) line = setFlag(line, 'dpi-desync-repeats', repeats);
    if (fakeTls !== rule.fakeTls) {
      line = setFlag(line, 'dpi-desync-fake-tls', fakeTls ? `"%BIN%${fakeTls}"` : '');
    }
    lines[rule.lineIndex] = line;
  }
  return lines.join(source.includes('\r\n') ? '\r\n' : '\n');
}

function customStrategyFilename(name) {
  const clean = String(name || '').trim();
  if (!/^[\p{L}\p{N} _-]{1,32}$/u.test(clean)) {
    throw new Error('Название: 1–32 буквы, цифры, пробелы, _ или -');
  }
  return `general (CUSTOM ${clean}).bat`;
}

module.exports = { describeStrategy, buildStrategy, customStrategyFilename, validatePorts };
