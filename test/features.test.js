const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describeStrategy, buildStrategy, customStrategyFilename } = require('../src/strategy-editor');
const { CLOUDFLARE_DNS_SERVERS, TARGET_SERVICES, summarizeStrategy, pickAlternative, shouldSuggestSwitch, isHttpHealthy } = require('../src/smart-routing');

const sample = fs.readFileSync(path.join(__dirname, '../zapret/general.bat'), 'utf8');
const binFiles = ['tls_clienthello_www_google_com.bin', 'stun.bin'];
const originalRules = describeStrategy(sample);
const edits = () => originalRules.map(({ index, ports, desync, repeats, fakeTls }) => ({ index, ports, desync, repeats, fakeTls }));

test('unchanged visual editor preserves original batch exactly', () => {
  assert.ok(originalRules.length >= 5);
  assert.equal(buildStrategy(sample, edits(), binFiles), sample);
});

test('changes one TCP rule while preserving other rules', () => {
  const updated = edits();
  const tcp = originalRules.find((rule) => rule.protocol === 'TCP');
  updated[tcp.index].ports = '443,8443';
  updated[tcp.index].repeats = '9';
  updated[tcp.index].fakeTls = 'stun.bin';
  const output = buildStrategy(sample, updated, binFiles);
  const result = describeStrategy(output);
  assert.equal(result[tcp.index].ports, '443,8443');
  assert.equal(result[tcp.index].repeats, '9');
  assert.equal(result[tcp.index].fakeTls, 'stun.bin');
  assert.deepEqual(result.filter((r) => r.index !== tcp.index).map((r) => r.ports),
    originalRules.filter((r) => r.index !== tcp.index).map((r) => r.ports));
});

test('strategy builder rejects dangerous input and path traversal', () => {
  assert.throws(() => customStrategyFilename('../evil'), /Название/);
  assert.equal(customStrategyFilename('Для игр'), 'general (CUSTOM Для игр).bat');
  const badPorts = edits();
  badPorts[0].ports = '443 & del C:\\';
  assert.throws(() => buildStrategy(sample, badPorts, binFiles), /порт/);
  const badFile = edits();
  const tcp = originalRules.find((rule) => rule.protocol === 'TCP');
  badFile[tcp.index].fakeTls = '..\\some.bat';
  assert.throws(() => buildStrategy(sample, badFile, binFiles), /TLS/);
});

test('smart switching requires known service success and an online control site', () => {
  const first = summarizeStrategy({
    config: 'general (ALT).bat', score: { total: 20, ok: 7 }, targetResults: [
      { name: 'YouTubeWeb', checks: [{ ok: true }] },
      { name: 'DiscordMain', checks: [{ ok: true }] }
    ]
  });
  const second = summarizeStrategy({
    config: 'general (ALT2).bat', score: { total: 30, ok: 8 }, targetResults: [
      { name: 'YouTubeWeb', checks: [{ ok: true }] },
      { name: 'DiscordMain', checks: [{ ok: false }] }
    ]
  });
  const available = ['general.bat', first.config, second.config];
  assert.equal(pickAlternative([second, first], available, 'general.bat', ['discord']).config, first.config);
  assert.equal(pickAlternative([second, first], available, 'general.bat', ['youtube']).config, second.config);
  assert.equal(pickAlternative([second, first], available, 'general.bat', ['other']), null);
  assert.equal(shouldSuggestSwitch({ cloudflare: { ok: true }, discord: { ok: false } }, 2, true), true);
  assert.equal(shouldSuggestSwitch({ cloudflare: { ok: false }, discord: { ok: false } }, 3, true), false);
  assert.equal(shouldSuggestSwitch({ cloudflare: { ok: true }, discord: { ok: false } }, 1, true), false);
});

test('Cloudflare DNS probes use bundled primary and backup resolver IPs', () => {
  assert.deepEqual(CLOUDFLARE_DNS_SERVERS, ['1.1.1.1', '1.0.0.1']);
  assert.deepEqual(TARGET_SERVICES.map(({ id }) => id), ['youtube', 'discord', 'cloudflare']);
  assert.equal(TARGET_SERVICES[2].servers, CLOUDFLARE_DNS_SERVERS);
  assert.match(TARGET_SERVICES[2].url, /^https:\/\/cloudflare-dns\.com\/dns-query\?/);
});

test('HTTP errors are not mistaken for successful connectivity', () => {
  for (const code of ['200', '204', '301', '302']) assert.equal(isHttpHealthy(code), true);
  for (const code of ['000', '403', '404', '503', 'ERR']) assert.equal(isHttpHealthy(code), false);
});
