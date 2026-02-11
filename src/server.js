const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const { loadConfig, getArgValue } = require("./shared/config");
const { ensureDir, readJson, writeJson, safeJoin } = require("./shared/fs");
const { listFiles } = require("./shared/scan");
const { normalizeIdx, compareIdx, isAfter } = require("./shared/idx");

const argv = process.argv.slice(2);
const configPath = getArgValue(argv, "--config") || "config/server.json";
const config = loadConfig(configPath);

validateConfig(config);

const stateDir = path.resolve(process.cwd(), config.state_dir || "./state");
const snapshotPath = path.join(stateDir, "snapshot.json");
const deletionsPath = path.join(stateDir, "deletions.jsonl");
const trashDir = path.resolve(process.cwd(), config.trash_dir);
const trashTtlMs = config.trash_ttl_days * 24 * 60 * 60 * 1000;
const ackTimeoutMs = config.ack_timeout_seconds * 1000;
const trashMaxBytes = config.trash_max_bytes;
const deletionsLogMaxLines = config.deletions_log_max_lines;
const deletionsLogCleanupIntervalMs =
  config.deletions_log_cleanup_interval_seconds * 1000;
let lastTrashCleanupAt = 0;
let lastDeletionsCleanupAt = 0;
let deletionsFileQueue = Promise.resolve();

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const ok = authenticate(request, config.auth);
  if (!ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  let awaitingAck = false;
  let batchId = null;
  let sentItems = [];
  let ackTimer = null;
  let queue = Promise.resolve();

  ws.on("message", (data) => {
    queue = queue
      .then(() => handleMessage(data))
      .catch((err) => {
        console.error("pull failed", err);
        ws.close();
      });
  });

  ws.on("close", () => {
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
  });

  ws.on("error", (err) => {
    console.error("ws error", err);
  });

  async function handleMessage(data) {
    const msg = parseJsonMessage(data);
    if (!msg) {
      return;
    }

    if (msg.type === "hello") {
      const lastIdx = normalizeIdx(msg.last_idx);
      const requestedMax = Number(msg.max_batch_bytes || 0);
      const effectiveMax = requestedMax > 0
        ? Math.min(requestedMax, config.max_batch_bytes)
        : config.max_batch_bytes;

      const delta = await buildDelta(lastIdx, effectiveMax);
      const hasItems = Array.isArray(delta.items) && delta.items.length > 0;
      batchId = hasItems ? createBatchId() : null;
      sentItems = delta.items;

      const publicItems = delta.items.map(({ absPath, ...rest }) => rest);
      const deltaPayload = {
        type: "delta",
        next_idx: delta.next_idx,
        truncated: delta.truncated,
        items: publicItems,
        deletions: delta.deletions,
      };
      if (hasItems) {
        deltaPayload.batch_id = batchId;
      }
      await sendJson(ws, deltaPayload);

      if (hasItems) {
        for (const item of delta.items) {
          await sendFile(ws, item, config.chunk_bytes || 1048576);
        }
      }

      const donePayload = {
        type: "done",
        next_idx: delta.next_idx,
        truncated: delta.truncated,
      };
      if (hasItems) {
        donePayload.batch_id = batchId;
      }
      await sendJson(ws, donePayload);

      if (!hasItems) {
        ws.close();
        return;
      }

      awaitingAck = true;
      ackTimer = setTimeout(() => {
        ws.close();
      }, ackTimeoutMs);
      return;
    }

    if (msg.type === "ack") {
      if (!awaitingAck || msg.batch_id !== batchId) {
        return;
      }
      awaitingAck = false;
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }

      const result = await trashBatch(sentItems);
      if (!result.ok) {
        await sendJson(ws, {
          type: "ack_error",
          batch_id: batchId,
          error: result.error,
        });
        ws.close();
        return;
      }

      await sendJson(ws, {
        type: "ack_ok",
        batch_id: batchId,
        trashed: result.trashed,
        missing: result.missing,
      });
      ws.close();
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`ws server listening on ${config.host}:${config.port}`);
});

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Invalid config");
  }
  if (!cfg.host) {
    cfg.host = "0.0.0.0";
  }
  if (!cfg.port) {
    throw new Error("port is required");
  }
  if (!cfg.session_dir) {
    throw new Error("session_dir is required");
  }
  if (!cfg.auth || !cfg.auth.user || !cfg.auth.pass) {
    throw new Error("auth.user and auth.pass are required");
  }
  if (!cfg.max_batch_bytes || Number(cfg.max_batch_bytes) <= 0) {
    cfg.max_batch_bytes = 3221225472;
  } else {
    cfg.max_batch_bytes = Number(cfg.max_batch_bytes);
  }
  if (!cfg.chunk_bytes || Number(cfg.chunk_bytes) <= 0) {
    cfg.chunk_bytes = 1048576;
  } else {
    cfg.chunk_bytes = Number(cfg.chunk_bytes);
  }
  if (!cfg.trash_dir) {
    cfg.trash_dir = "./trash";
  }
  if (!cfg.trash_ttl_days || Number(cfg.trash_ttl_days) <= 0) {
    cfg.trash_ttl_days = 7;
  } else {
    cfg.trash_ttl_days = Number(cfg.trash_ttl_days);
  }
  if (!cfg.ack_timeout_seconds || Number(cfg.ack_timeout_seconds) <= 0) {
    cfg.ack_timeout_seconds = 120;
  } else {
    cfg.ack_timeout_seconds = Number(cfg.ack_timeout_seconds);
  }
  if (
    !cfg.trash_cleanup_interval_seconds
    || Number(cfg.trash_cleanup_interval_seconds) <= 0
  ) {
    cfg.trash_cleanup_interval_seconds = 600;
  } else {
    cfg.trash_cleanup_interval_seconds = Number(cfg.trash_cleanup_interval_seconds);
  }
  if (!cfg.trash_max_bytes || Number(cfg.trash_max_bytes) <= 0) {
    cfg.trash_max_bytes = 5 * 1024 * 1024 * 1024;
  } else {
    cfg.trash_max_bytes = Number(cfg.trash_max_bytes);
  }
  if (!cfg.deletions_log_max_lines || Number(cfg.deletions_log_max_lines) <= 0) {
    cfg.deletions_log_max_lines = 200000;
  } else {
    cfg.deletions_log_max_lines = Number(cfg.deletions_log_max_lines);
  }
  if (
    !cfg.deletions_log_cleanup_interval_seconds
    || Number(cfg.deletions_log_cleanup_interval_seconds) <= 0
  ) {
    cfg.deletions_log_cleanup_interval_seconds = 600;
  } else {
    cfg.deletions_log_cleanup_interval_seconds = Number(
      cfg.deletions_log_cleanup_interval_seconds,
    );
  }
}

function authenticate(request, auth) {
  const header = request.headers["authorization"];
  if (!header || !header.startsWith("Basic ")) {
    return false;
  }
  const raw = header.slice("Basic ".length);
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) {
    return false;
  }
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === auth.user && pass === auth.pass;
}

function parseJsonMessage(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

async function sendJson(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), { binary: false }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sendFile(ws, item, chunkBytes) {
  const absPath = item.absPath;
  await sendJson(ws, {
    type: "file_start",
    id: item.id,
    idx: item.idx,
    size: item.size,
    mtimeMs: item.mtimeMs,
  });

  const stream = fs.createReadStream(absPath, { highWaterMark: chunkBytes });
  let sentBytes = 0;
  try {
    for await (const chunk of stream) {
      await waitForBuffer(ws, 8 * 1024 * 1024);
      sentBytes += chunk.length;
      await sendBinary(ws, chunk);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }

  await sendJson(ws, {
    type: "file_end",
    id: item.id,
    idx: item.idx,
    size: sentBytes,
  });
}

async function sendBinary(ws, chunk) {
  return new Promise((resolve, reject) => {
    ws.send(chunk, { binary: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function waitForBuffer(ws, limit) {
  while (ws.bufferedAmount > limit) {
    await delay(10);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBatchId() {
  return crypto.randomBytes(16).toString("hex");
}

async function buildDelta(lastIdx, maxBatchBytes) {
  await ensureDir(stateDir);

  const previous = await readJson(snapshotPath, {});
  const files = (await listFiles(config.session_dir)).filter((file) =>
    file.id.toLowerCase().endsWith(".json"),
  );

  const current = {};
  for (const file of files) {
    current[file.id] = { mtimeMs: file.mtimeMs, size: file.size };
  }

  const deletions = [];
  const now = Date.now();
  for (const id of Object.keys(previous)) {
    if (!current[id]) {
      deletions.push({
        id,
        idx: { mtimeMs: now, id },
      });
    }
  }

  if (deletions.length > 0) {
    await appendDeletions(deletions);
  }
  await writeJson(snapshotPath, current);

  const deletionEvents = await readDeletionsAfter(lastIdx);

  const events = [];
  for (const file of files) {
    const idx = { mtimeMs: file.mtimeMs, id: file.id };
    if (isAfter(idx, lastIdx)) {
      events.push({ type: "upsert", idx, file });
    }
  }
  for (const del of deletionEvents) {
    events.push({ type: "delete", idx: del.idx, id: del.id });
  }

  events.sort((a, b) => compareIdx(a.idx, b.idx));

  const items = [];
  const deletionList = [];
  let totalBytes = 0;
  let nextIdx = normalizeIdx(lastIdx);
  let truncated = false;

  for (const event of events) {
    if (event.type === "upsert") {
      const size = event.file.size;
      if (totalBytes > 0 && totalBytes + size > maxBatchBytes) {
        truncated = true;
        break;
      }
      totalBytes += size;
      items.push({
        id: event.file.id,
        idx: event.idx,
        mtimeMs: event.file.mtimeMs,
        size: event.file.size,
        absPath: event.file.absPath,
      });
      nextIdx = event.idx;
      continue;
    }

    deletionList.push({ id: event.id, idx: event.idx });
    nextIdx = event.idx;
  }

  if (!truncated && items.length + deletionList.length < events.length) {
    truncated = true;
  }

  return {
    items,
    deletions: deletionList,
    next_idx: nextIdx,
    truncated,
  };
}

async function trashBatch(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, trashed: 0, missing: 0 };
  }

  try {
    await ensureDir(trashDir);
    await cleanupTrashExpired();
  } catch (err) {
    return { ok: false, error: "trash cleanup failed" };
  }

  const movedIds = [];
  let missing = 0;

  for (const item of items) {
    try {
      const target = buildTrashPath(item.id);
      const finalTarget = await moveToTrashWithCleanup(item.absPath, target);
      await touchNow(finalTarget);
      movedIds.push(item.id);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        missing += 1;
        continue;
      }
      return { ok: false, error: err && err.code ? err.code : "trash failed" };
    }
  }

  await updateSnapshotAfterTrash(movedIds);
  return { ok: true, trashed: movedIds.length, missing };
}

function buildTrashPath(relId) {
  return safeJoin(trashDir, relId);
}

async function moveToTrashWithCleanup(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  const finalTarget = await ensureUniquePath(targetPath);

  while (true) {
    try {
      await moveFile(sourcePath, finalTarget);
      return finalTarget;
    } catch (err) {
      if (err && err.code === "ENOSPC") {
        const removed = await cleanupTrashAll();
        if (removed === 0) {
          throw err;
        }
        continue;
      }
      throw err;
    }
  }
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await copyFileStream(sourcePath, targetPath);
      await fs.promises.unlink(sourcePath);
      return;
    }
    throw err;
  }
}

async function copyFileStream(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  return new Promise((resolve, reject) => {
    const reader = fs.createReadStream(sourcePath);
    const writer = fs.createWriteStream(targetPath, { flags: "w" });
    reader.once("error", reject);
    writer.once("error", reject);
    writer.once("close", resolve);
    reader.pipe(writer);
  });
}

async function ensureUniquePath(targetPath) {
  let candidate = targetPath;
  let attempt = 0;
  while (true) {
    try {
      await fs.promises.access(candidate);
      attempt += 1;
      const dir = path.dirname(targetPath);
      const base = path.basename(targetPath);
      const suffix = `.dup-${Date.now()}-${attempt}`;
      candidate = path.join(dir, `${base}${suffix}`);
    } catch (err) {
      return candidate;
    }
  }
}

async function touchNow(filePath) {
  const now = new Date();
  try {
    await fs.promises.utimes(filePath, now, now);
  } catch (err) {
    return;
  }
}

async function cleanupTrashExpired() {
  const now = Date.now();
  if (
    lastTrashCleanupAt > 0
    && now - lastTrashCleanupAt
      < config.trash_cleanup_interval_seconds * 1000
  ) {
    return 0;
  }
  lastTrashCleanupAt = now;
  const files = await listTrashFiles();
  if (files.length === 0) {
    return 0;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (trashMaxBytes > 0 && totalBytes >= trashMaxBytes) {
    return await cleanupTrashAll(files);
  }
  if (!trashTtlMs || trashTtlMs <= 0) {
    return 0;
  }
  const expired = files
    .filter((file) => now - file.mtimeMs > trashTtlMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let removed = 0;
  for (const file of expired) {
    try {
      await fs.promises.unlink(file.absPath);
      await removeEmptyParents(path.dirname(file.absPath), trashDir);
      removed += 1;
    } catch (err) {
      continue;
    }
  }
  return removed;
}

async function cleanupTrashAll(prefetched) {
  const files = Array.isArray(prefetched) ? prefetched : await listTrashFiles();
  if (files.length === 0) {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    try {
      await fs.promises.unlink(file.absPath);
      await removeEmptyParents(path.dirname(file.absPath), trashDir);
      removed += 1;
    } catch (err) {
      continue;
    }
  }
  return removed;
}

async function listTrashFiles() {
  try {
    return await listFiles(trashDir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
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

async function updateSnapshotAfterTrash(movedIds) {
  if (!Array.isArray(movedIds) || movedIds.length === 0) {
    return;
  }
  const snapshot = await readJson(snapshotPath, {});
  let changed = false;
  for (const id of movedIds) {
    if (snapshot[id]) {
      delete snapshot[id];
      changed = true;
    }
  }
  if (changed) {
    await writeJson(snapshotPath, snapshot);
  }
}

async function appendDeletions(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  await ensureDir(stateDir);
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  deletionsFileQueue = deletionsFileQueue
    .then(async () => {
      await fs.promises.appendFile(deletionsPath, lines, "utf8");
      await maybeCompactDeletionsLog();
    })
    .catch((err) => {
      console.error("deletions log update failed", err);
    });
  await deletionsFileQueue;
}

async function maybeCompactDeletionsLog() {
  const now = Date.now();
  if (
    lastDeletionsCleanupAt > 0
    && now - lastDeletionsCleanupAt < deletionsLogCleanupIntervalMs
  ) {
    return;
  }
  lastDeletionsCleanupAt = now;
  await compactDeletionsLog();
}

async function compactDeletionsLog() {
  if (!deletionsLogMaxLines || deletionsLogMaxLines <= 0) {
    return;
  }
  let raw;
  try {
    raw = await fs.promises.readFile(deletionsPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= deletionsLogMaxLines) {
    return;
  }
  const keep = lines.slice(lines.length - deletionsLogMaxLines);
  const nextRaw = `${keep.join("\n")}\n`;
  const tmpPath = `${deletionsPath}.tmp`;
  await fs.promises.writeFile(tmpPath, nextRaw, "utf8");
  await fs.promises.rename(tmpPath, deletionsPath);
}

async function readDeletionsAfter(lastIdx) {
  try {
    await deletionsFileQueue;
    const raw = await fs.promises.readFile(deletionsPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const results = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && entry.idx && isAfter(entry.idx, lastIdx)) {
          results.push(entry);
        }
      } catch (err) {
        continue;
      }
    }
    return results;
  } catch (err) {
    return [];
  }
}
