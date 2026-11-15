const CLOUDFLARE_DNS_SERVERS = Object.freeze(['1.1.1.1', '1.0.0.1']);

const TARGET_SERVICES = Object.freeze([
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app' },
  {
    id: 'cloudflare',
    name: 'Cloudflare (контроль)',
    url: 'https://cloudflare-dns.com/dns-query?name=example.com&type=A',
    servers: CLOUDFLARE_DNS_SERVERS
  }
]);

function summarizeStrategy(result, checkedAt = Date.now()) {
  const serviceChecks = { youtube: [], discord: [] };
  for (const target of result.targetResults || []) {
    const lower = String(target.name || '').toLowerCase();
    const id = lower.includes('youtube') ? 'youtube' : lower.includes('discord') ? 'discord' : null;
    if (!id) continue;
    const checks = (target.checks || []).filter((check) => !check.unsupported);
    if (checks.length) serviceChecks[id].push(checks.some((check) => check.ok));
  }
  const services = {};
  for (const [id, checks] of Object.entries(serviceChecks)) {
    services[id] = checks.length ? checks.some(Boolean) : null;
  }
  return {
    config: result.config,
    total: result.score?.total ?? 0,
    ok: result.score?.ok ?? 0,
    services,
    checkedAt
  };
}

function pickAlternative(history, availableNames, currentName, failedServices, skippedNames = []) {
  const available = new Set(availableNames);
  const skipped = new Set([currentName, ...skippedNames]);
  const eligible = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && available.has(entry.config) && !skipped.has(entry.config))
    .filter((entry) => Number.isFinite(entry.total) && entry.ok > 0)
    // A strategy without a passed test for the broken service is not a safe candidate.
    .filter((entry) => failedServices.every((id) => entry.services?.[id] === true));
  eligible.sort((a, b) => b.total - a.total || b.checkedAt - a.checkedAt);
  return eligible[0] || null;
}

function shouldSuggestSwitch(services, streak, enabled, baseline = 'cloudflare') {
  if (!enabled || streak < 2 || !services?.[baseline]?.ok) return false;
  return ['youtube', 'discord'].some((id) => services[id]?.ok === false);
}

function isHttpHealthy(statusCode) {
  const status = Number(statusCode);
  return Number.isInteger(status) && status >= 200 && status < 400;
}

module.exports = { CLOUDFLARE_DNS_SERVERS, TARGET_SERVICES, summarizeStrategy, pickAlternative, shouldSuggestSwitch, isHttpHealthy };
