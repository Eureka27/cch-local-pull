const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ensureDir, safeJoin } = require("./fs");

async function rebuildSessionFromDup(options) {
  const {
    sessionId,
    rawDir,
    reportsDir,
    safeUnlink,
    removeEmptyParents,
  } = options;
  const sourceFiles = await collectSessionFilesForRebuild(rawDir, sessionId);
  const report = {
    session_id: sessionId,
    generated_at: new Date().toISOString(),
    source_file_count: sourceFiles.length,
    parsed_event_count: 0,
    valid_event_count: 0,
    invalid_line_count: 0,
    invalid_sequence_count: 0,
    dedup_dropped_count: 0,
    conflict_count: 0,
    conflict_replaced_count: 0,
    output_event_count: 0,
    output_path: safeJoin(rawDir, `${sessionId}.json`),
    cleaned_dup_file_count: 0,
  };
  if (sourceFiles.length === 0) {
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
  report.output_event_count = selected.length;

  const outputPath = safeJoin(rawDir, `${sessionId}.json`);
  await writeTextAtomic(outputPath, renderJsonl(selected));

  const dupFiles = sourceFiles.filter((item) => isDupFileName(path.basename(item.absPath)));
  for (const dupFile of dupFiles) {
    await safeUnlink(dupFile.absPath);
    await removeEmptyParents(path.dirname(dupFile.absPath), rawDir);
  }
  report.cleaned_dup_file_count = dupFiles.length;
  await writeDupReport(reportsDir, report);
  return report;
}

async function collectSessionFilesForRebuild(rawDir, sessionId) {
  const root = path.resolve(rawDir);
  const files = [];
  const seen = new Set();

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
    if (!stat || !stat.isFile() || seen.has(absPath)) {
      continue;
    }
    seen.add(absPath);
    files.push({ absPath, mtimeMs: stat.mtimeMs });
  }

  const nestedRoot = path.join(root, sessionId);
  const nestedStat = await safeStat(nestedRoot);
  if (nestedStat && nestedStat.isDirectory()) {
    await walkFiles(nestedRoot, async (absPath) => {
      if (!isJsonFamilyFile(path.basename(absPath))) {
        return;
      }
      const stat = await safeStat(absPath);
      if (!stat || !stat.isFile() || seen.has(absPath)) {
        return;
      }
      seen.add(absPath);
      files.push({ absPath, mtimeMs: stat.mtimeMs });
    });
  }

  files.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs - b.mtimeMs;
    }
    return a.absPath.localeCompare(b.absPath);
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

async function writeTextAtomic(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, text, "utf8");
  await fs.promises.rename(tempPath, filePath);
}

async function writeDupReport(reportsDir, report) {
  const reportPath = safeJoin(reportsDir, `${report.session_id}.json`);
  await writeTextAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function isSessionTopFile(fileName, sessionId) {
  return fileName === `${sessionId}.json`
    || fileName.startsWith(`${sessionId}.json.dup-`);
}

function isJsonFamilyFile(fileName) {
  const lower = String(fileName || "").toLowerCase();
  return lower.endsWith(".json") || lower.includes(".json.dup-");
}

function isDupFileName(fileName) {
  return String(fileName || "").toLowerCase().includes(".json.dup-");
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

module.exports = {
  rebuildSessionFromDup,
};
