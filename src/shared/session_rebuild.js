const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ensureDir, safeJoin } = require("./fs");

function extractSessionIdFromFileId(fileId) {
  if (!fileId || typeof fileId !== "string") {
    return null;
  }
  const normalized = fileId.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }
  const first = normalized.split("/")[0];
  if (!first) {
    return null;
  }
  return stripSessionSuffix(first);
}

function stripSessionSuffix(fileName) {
  let value = String(fileName || "");
  value = value.replace(/\.json\.dup-\d+-\d+$/i, "");
  value = value.replace(/\.json$/i, "");
  return value || null;
}

async function rebuildSessionArtifacts(options) {
  const {
    rawDir,
    processedDir,
    reportsDir,
    sessionId,
    strictSequenceStartAtOne,
    cache,
  } = options;

  const sourceFiles = await collectSessionFiles(rawDir, sessionId);
  const sourceFingerprint = buildSourceFingerprint(sourceFiles);
  const report = {
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    cache_hit: false,
    source_file_count: sourceFiles.length,
    source_files: sourceFiles.map((item) => ({
      rel_path: item.relPath,
      mtime_ms: item.mtimeMs,
      size: item.size,
    })),
    parsed_event_count: 0,
    valid_event_count: 0,
    invalid_line_count: 0,
    invalid_sequence_count: 0,
    dedup_dropped_count: 0,
    conflict_count: 0,
    conflict_replaced_count: 0,
    continuity: {
      strict_start_at_one: Boolean(strictSequenceStartAtOne),
      continuous: false,
      missing_sequences: [],
      max_sequence: 0,
      min_sequence: 0,
    },
    output: {
      status: "none",
      path: null,
      event_count: 0,
    },
  };

  const cachedReport = readCachedReport(cache, sessionId, sourceFingerprint);
  if (cachedReport) {
    return cachedReport;
  }

  if (sourceFiles.length === 0) {
    await cleanupOutputFiles(processedDir, sessionId);
    report.output.status = "removed";
    await writeReport(reportsDir, sessionId, report);
    saveCachedReport(cache, sessionId, sourceFingerprint, report);
    return report;
  }

  const candidates = [];
  let sourceOrder = 0;
  for (const file of sourceFiles) {
    const parsed = await parseJsonlFile(file.absPath);
    report.invalid_line_count += parsed.invalidLineCount;
    for (const event of parsed.events) {
      sourceOrder += 1;
      report.parsed_event_count += 1;
      candidates.push({
        event,
        sourceMtimeMs: file.mtimeMs,
        sourceOrder,
      });
    }
  }

  const selectedByConflictKey = new Map();
  const dedupeSet = new Set();

  for (const candidate of candidates) {
    const normalized = normalizeEvent(candidate.event);
    if (!normalized) {
      report.invalid_sequence_count += 1;
      continue;
    }
    report.valid_event_count += 1;

    const dedupeKey = `${normalized.sequence}|${normalized.type}|${normalized.payloadHash}`;
    if (dedupeSet.has(dedupeKey)) {
      report.dedup_dropped_count += 1;
      continue;
    }
    dedupeSet.add(dedupeKey);

    const conflictKey = `${normalized.sequence}|${normalized.type}`;
    const existing = selectedByConflictKey.get(conflictKey);
    if (!existing) {
      selectedByConflictKey.set(conflictKey, {
        event: candidate.event,
        sequence: normalized.sequence,
        type: normalized.type,
        payloadHash: normalized.payloadHash,
        sourceMtimeMs: candidate.sourceMtimeMs,
        sourceOrder: candidate.sourceOrder,
      });
      continue;
    }

    if (existing.payloadHash === normalized.payloadHash) {
      report.dedup_dropped_count += 1;
      continue;
    }

    report.conflict_count += 1;
    if (shouldReplace(existing, candidate)) {
      report.conflict_replaced_count += 1;
      selectedByConflictKey.set(conflictKey, {
        event: candidate.event,
        sequence: normalized.sequence,
        type: normalized.type,
        payloadHash: normalized.payloadHash,
        sourceMtimeMs: candidate.sourceMtimeMs,
        sourceOrder: candidate.sourceOrder,
      });
    }
  }

  const selected = Array.from(selectedByConflictKey.values())
    .sort(compareSelected)
    .map((item) => item.event);
  report.output.event_count = selected.length;

  const sequences = selected
    .map((event) => Number(event.requestSequence))
    .filter((value) => Number.isInteger(value) && value > 0);
  const continuity = checkContinuity(sequences, Boolean(strictSequenceStartAtOne));
  report.continuity = continuity;

  const relFile = `${sessionId}.json`;
  const completePath = safeJoin(processedDir, relFile);
  const incompletePath = safeJoin(processedDir, `_incomplete/${relFile}`);
  const jsonl = renderJsonl(selected);

  if (continuity.continuous) {
    await writeTextAtomic(completePath, jsonl);
    await safeUnlink(incompletePath);
    await removeEmptyParents(path.dirname(incompletePath), safeJoin(processedDir, "_incomplete"));
    report.output.status = "complete";
    report.output.path = completePath;
  } else {
    await writeTextAtomic(incompletePath, jsonl);
    await safeUnlink(completePath);
    report.output.status = "incomplete";
    report.output.path = incompletePath;
  }

  await writeReport(reportsDir, sessionId, report);
  saveCachedReport(cache, sessionId, sourceFingerprint, report);
  return report;
}

function buildSourceFingerprint(sourceFiles) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    return "empty";
  }
  const values = sourceFiles.map((item) => `${item.relPath}|${item.mtimeMs}|${item.size}`);
  return values.join(";");
}

function readCachedReport(cache, sessionId, fingerprint) {
  if (!(cache instanceof Map)) {
    return null;
  }
  const cached = cache.get(sessionId);
  if (!cached || cached.fingerprint !== fingerprint || !cached.report) {
    return null;
  }
  const report = cloneJson(cached.report);
  report.generated_at = new Date().toISOString();
  report.cache_hit = true;
  return report;
}

function saveCachedReport(cache, sessionId, fingerprint, report) {
  if (!(cache instanceof Map)) {
    return;
  }
  cache.set(sessionId, {
    fingerprint,
    report: cloneJson(report),
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function collectSessionFiles(rawDir, sessionId) {
  const files = [];
  const seen = new Set();
  const root = path.resolve(rawDir);

  const topLevel = await safeReadDir(root);
  for (const entry of topLevel) {
    if (!entry.isFile()) {
      continue;
    }
    if (!isSessionTopFile(entry.name, sessionId)) {
      continue;
    }
    const absPath = path.join(root, entry.name);
    const stat = await safeStat(absPath);
    if (!stat || !stat.isFile()) {
      continue;
    }
    const key = absPath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push({
      absPath,
      relPath: entry.name,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }

  const nestedRoot = path.join(root, sessionId);
  const nestedStat = await safeStat(nestedRoot);
  if (nestedStat && nestedStat.isDirectory()) {
    await walkFiles(nestedRoot, async (absPath) => {
      const relPath = path.relative(root, absPath).split(path.sep).join("/");
      if (!isJsonFamilyFile(path.basename(absPath))) {
        return;
      }
      const stat = await safeStat(absPath);
      if (!stat || !stat.isFile()) {
        return;
      }
      if (seen.has(absPath)) {
        return;
      }
      seen.add(absPath);
      files.push({
        absPath,
        relPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    });
  }

  files.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs - b.mtimeMs;
    }
    return a.relPath.localeCompare(b.relPath);
  });
  return files;
}

async function walkFiles(dirPath, onFile) {
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await safeReadDir(current);
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      await onFile(absPath);
    }
  }
}

async function parseJsonlFile(filePath) {
  const result = {
    events: [],
    invalidLineCount: 0,
  };
  let raw = "";
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    return result;
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        result.invalidLineCount += 1;
        continue;
      }
      result.events.push(event);
    } catch (err) {
      result.invalidLineCount += 1;
    }
  }
  return result;
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const sequence = Number(event.requestSequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "__unknown__";
  const payloadHash = hashPayload(event.payload);
  return {
    sequence,
    type,
    payloadHash,
  };
}

function hashPayload(payload) {
  const raw = stableStringify(payload);
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stableStringify(item));
    return `[${items.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${parts.join(",")}}`;
}

function shouldReplace(existing, candidate) {
  if (candidate.sourceMtimeMs > existing.sourceMtimeMs) {
    return true;
  }
  if (candidate.sourceMtimeMs < existing.sourceMtimeMs) {
    return false;
  }
  return candidate.sourceOrder > existing.sourceOrder;
}

function compareSelected(a, b) {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  if (a.sourceMtimeMs !== b.sourceMtimeMs) {
    return a.sourceMtimeMs - b.sourceMtimeMs;
  }
  return a.sourceOrder - b.sourceOrder;
}

function checkContinuity(sequences, strictStartAtOne) {
  if (!Array.isArray(sequences) || sequences.length === 0) {
    return {
      strict_start_at_one: strictStartAtOne,
      continuous: false,
      missing_sequences: [],
      max_sequence: 0,
      min_sequence: 0,
    };
  }
  const uniq = Array.from(new Set(sequences)).sort((a, b) => a - b);
  const uniqSet = new Set(uniq);
  const min = uniq[0];
  const max = uniq[uniq.length - 1];
  const start = strictStartAtOne ? 1 : min;
  const missing = [];
  for (let sequence = start; sequence <= max; sequence += 1) {
    if (!uniqSet.has(sequence)) {
      missing.push(sequence);
    }
  }
  const continuous = missing.length === 0 && (!strictStartAtOne || min === 1);
  return {
    strict_start_at_one: strictStartAtOne,
    continuous,
    missing_sequences: missing,
    max_sequence: max,
    min_sequence: min,
  };
}

function renderJsonl(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return "";
  }
  const lines = [];
  for (const event of events) {
    lines.push(JSON.stringify(event));
  }
  return `${lines.join("\n")}\n`;
}

async function writeReport(reportsDir, sessionId, report) {
  const reportPath = safeJoin(reportsDir, `${sessionId}.json`);
  await writeTextAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function cleanupOutputFiles(processedDir, sessionId) {
  const rel = `${sessionId}.json`;
  const completePath = safeJoin(processedDir, rel);
  const incompletePath = safeJoin(processedDir, `_incomplete/${rel}`);
  await safeUnlink(completePath);
  await safeUnlink(incompletePath);
  await removeEmptyParents(path.dirname(incompletePath), safeJoin(processedDir, "_incomplete"));
}

async function writeTextAtomic(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, text, "utf8");
  await fs.promises.rename(tempPath, filePath);
}

async function safeReadDir(dirPath) {
  try {
    return await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return [];
  }
}

async function safeStat(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (err) {
    return null;
  }
}

function isSessionTopFile(fileName, sessionId) {
  return fileName === `${sessionId}.json`
    || fileName.startsWith(`${sessionId}.json.dup-`);
}

function isJsonFamilyFile(fileName) {
  return fileName.toLowerCase().endsWith(".json")
    || fileName.toLowerCase().includes(".json.dup-");
}

async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    return;
  }
}

async function removeEmptyParents(startDir, rootDir) {
  const root = path.resolve(rootDir);
  let current = path.resolve(startDir);
  while (current.startsWith(root + path.sep)) {
    try {
      await fs.promises.rmdir(current);
    } catch (err) {
      return;
    }
    current = path.dirname(current);
  }
}

module.exports = {
  extractSessionIdFromFileId,
  rebuildSessionArtifacts,
  stripSessionSuffix,
};
