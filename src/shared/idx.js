function normalizeIdx(idx) {
  if (!idx || typeof idx !== "object") {
    return { mtimeMs: 0, id: "" };
  }
  const mtimeMs = Number(idx.mtimeMs || 0);
  const id = typeof idx.id === "string" ? idx.id : "";
  return { mtimeMs, id };
}

function compareIdx(a, b) {
  const left = normalizeIdx(a);
  const right = normalizeIdx(b);
  if (left.mtimeMs !== right.mtimeMs) {
    return left.mtimeMs - right.mtimeMs;
  }
  return left.id.localeCompare(right.id);
}

function isAfter(a, b) {
  return compareIdx(a, b) > 0;
}

function maxIdx(a, b) {
  return compareIdx(a, b) >= 0 ? normalizeIdx(a) : normalizeIdx(b);
}

module.exports = {
  normalizeIdx,
  compareIdx,
  isAfter,
  maxIdx,
};
