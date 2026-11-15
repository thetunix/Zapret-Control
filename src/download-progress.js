function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.floor(number))) : 0;
}

function monotonicDownloadPercent(previous, loaded, total) {
  const current = clampPercent(previous);
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return current;
  return Math.max(current, clampPercent((loaded / total) * 100));
}

module.exports = { clampPercent, monotonicDownloadPercent };
