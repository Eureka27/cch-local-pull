const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const { loadConfig, getArgValue } = require("./shared/config");
const { ensureDir, readJson, writeJson, safeJoin } = require("./shared/fs");
const { normalizeIdx } = require("./shared/idx");
const { rebuildSessionFromDup } = require("./shared/session_merge");

const argv = process.argv.slice(2);
const configPath = getArgValue(argv, "--config") || "config/client.json";
const runOnce = argv.includes("--once");
const config = loadConfig(configPath);
const DEFAULT_PULL_INTERVAL_SECONDS = 7200;
const DEFAULT_EAGER_PULL_PENDING_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_EAGER_PULL_CHECK_INTERVAL_SECONDS = 60;

validateConfig(config);

const stateDir = path.resolve(process.cwd(), path.dirname(config.last_idx_path));
let pulling = false;
let probing = false;

start();

async function start() {
  await ensureDir(config.raw_dir);
  await ensureDir(config.reports_dir);
  await ensureDir(stateDir);

  await pullOnce();

  if (runOnce) {
    return;
  }

  const intervalMs = config.pull_interval_seconds * 1000;
  setInterval(() => {
    if (!pulling && !probing) {
      pullOnce();
    }
  }, intervalMs);

  if (config.eager_pull_pending_bytes > 0) {
    const probeIntervalMs = config.eager_pull_check_interval_seconds * 1000;
    setInterval(() => {
      if (!pulling && !probing) {
        probeAndPullIfNeeded();
      }
    }, probeIntervalMs);
  }
}

async function pullOnce() {
  pulling = true;
  try {
    const lastIdx = normalizeIdx(await readJson(config.last_idx_path, null));
    await doPull(lastIdx);
  } catch (err) {
    console.error("pull failed", err);
  } finally {
    pulling = false;
  }
}

async function probeAndPullIfNeeded() {
  if (pulling || probing) {
    return;
  }
  probing = true;
  try {
    const lastIdx = normalizeIdx(await readJson(config.last_idx_path, null));
    const summary = await probeDelta(lastIdx);
    if (!summary) {
      return;
    }
    if (summary.pending_bytes < config.eager_pull_pending_bytes) {
      return;
    }
    console.log(
      `[eager-pull] pending_bytes=${summary.pending_bytes} pending_files=${summary.pending_files} threshold=${config.eager_pull_pending_bytes}`,
    );
    await pullOnce();
  } catch (err) {
    console.error("eager pull probe failed", err);
  } finally {
    probing = false;
  }
}

async function doPull(lastIdx) {
  return new Promise((resolve) => {
    const authHeader = buildBasicAuth(config.auth.user, config.auth.pass);
    const ws = new WebSocket(config.server_url, {
      headers: {
        Authorization: authHeader,
      },
    });

    let expectedFiles = 0;
    let completedFiles = 0;
    let currentFile = null;
    let truncated = false;
    let batchId = null;
    let pendingNextIdx = null;
    let awaitingAck = false;
    let ackTimer = null;
    let queue = Promise.resolve();

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          last_idx: lastIdx,
          max_batch_bytes: config.max_batch_bytes,
        }),
      );
    });

    ws.on("message", (data, isBinary) => {
      queue = queue
        .then(() => handleMessage(data, isBinary))
        .catch((err) => {
          console.error("pull handler failed", err);
          ws.close();
        });
    });

    ws.on("close", () => {
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      resolve();
    });
    ws.on("error", (err) => {
      console.error("ws error", err);
      resolve();
    });

    async function handleMessage(data, isBinary) {
      if (isBinary) {
        if (!currentFile) {
          ws.close();
          return;
        }
        await writeChunk(currentFile, data);
        return;
      }

      const msg = parseJsonMessage(data);
      if (!msg) {
        return;
      }

      if (msg.type === "delta") {
        expectedFiles = Array.isArray(msg.items) ? msg.items.length : 0;
        truncated = Boolean(msg.truncated);
        batchId = msg.batch_id || batchId;

        if (Array.isArray(msg.deletions)) {
          for (const del of msg.deletions) {
            await applyDeletion(del && del.id);
          }
        }
        return;
      }

      if (msg.type === "file_start") {
        currentFile = await openFile(msg);
        return;
      }

      if (msg.type === "file_end") {
        if (!currentFile) {
          ws.close();
          return;
        }
        await closeFile(currentFile, msg);
        completedFiles += 1;
        currentFile = null;
        return;
      }

      if (msg.type === "done") {
        if (completedFiles !== expectedFiles || currentFile) {
          ws.close();
          return;
        }
        pendingNextIdx = normalizeIdx(msg.next_idx);
        if (!msg.batch_id && !batchId) {
          await writeJson(config.last_idx_path, pendingNextIdx);
          ws.close();
          if (truncated && !runOnce) {
            setTimeout(() => {
              if (!pulling) {
                pullOnce();
              }
            }, 1000);
          }
          return;
        }

        if (msg.batch_id) {
          batchId = msg.batch_id;
        }
        awaitingAck = true;
        startAckTimer();
        ws.send(JSON.stringify({ type: "ack", batch_id: batchId }));
        return;
      }

      if (msg.type === "ack_ok") {
        if (!awaitingAck || msg.batch_id !== batchId) {
          return;
        }
        awaitingAck = false;
        clearAckTimer();
        if (!pendingNextIdx) {
          ws.close();
          return;
        }
        await writeJson(config.last_idx_path, pendingNextIdx);
        ws.close();
        if (truncated && !runOnce) {
          setTimeout(() => {
            if (!pulling) {
              pullOnce();
            }
          }, 1000);
        }
        return;
      }

      if (msg.type === "ack_error") {
        if (!awaitingAck || msg.batch_id !== batchId) {
          return;
        }
        awaitingAck = false;
        clearAckTimer();
        console.error("ack failed", msg.error || "unknown");
        ws.close();
      }
    }

    function startAckTimer() {
      clearAckTimer();
      ackTimer = setTimeout(() => {
        if (!awaitingAck) {
          return;
        }
        console.error("ack timeout");
        ws.close();
      }, config.ack_timeout_seconds * 1000);
    }

    function clearAckTimer() {
      if (!ackTimer) {
        return;
      }
      clearTimeout(ackTimer);
      ackTimer = null;
    }
  });
}

async function probeDelta(lastIdx) {
  return new Promise((resolve) => {
    const authHeader = buildBasicAuth(config.auth.user, config.auth.pass);
    const ws = new WebSocket(config.server_url, {
      headers: {
        Authorization: authHeader,
      },
    });

    let resolved = false;

    function finish(result) {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(result);
    }

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          last_idx: lastIdx,
          max_batch_bytes: config.max_batch_bytes,
          summary_only: true,
        }),
      );
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const msg = parseJsonMessage(data);
      if (!msg || msg.type !== "delta_summary") {
        return;
      }
      finish(msg);
      ws.close();
    });

    ws.on("close", () => {
      finish(null);
    });

    ws.on("error", (err) => {
      console.error("ws probe error", err);
      finish(null);
    });
  });
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Invalid config");
  }
  if (!cfg.server_url) {
    throw new Error("server_url is required");
  }
  if (!cfg.auth || !cfg.auth.user || !cfg.auth.pass) {
    throw new Error("auth.user and auth.pass are required");
  }

  if (!cfg.raw_dir && cfg.dest_dir) {
    cfg.raw_dir = cfg.dest_dir;
  }
  if (!cfg.raw_dir) {
    throw new Error("raw_dir is required (or provide legacy dest_dir)");
  }
  if (!cfg.reports_dir) {
    cfg.reports_dir = "./state/reports";
  }
  if (!cfg.last_idx_path) {
    cfg.last_idx_path = "./state/last_idx.json";
  }
  if (!cfg.max_batch_bytes || Number(cfg.max_batch_bytes) <= 0) {
    cfg.max_batch_bytes = 3221225472;
  } else {
    cfg.max_batch_bytes = Number(cfg.max_batch_bytes);
  }
  if (!cfg.pull_interval_seconds || Number(cfg.pull_interval_seconds) <= 0) {
    cfg.pull_interval_seconds = DEFAULT_PULL_INTERVAL_SECONDS;
  } else {
    cfg.pull_interval_seconds = Number(cfg.pull_interval_seconds);
  }
  if (cfg.eager_pull_pending_bytes == null || cfg.eager_pull_pending_bytes === "") {
    cfg.eager_pull_pending_bytes = DEFAULT_EAGER_PULL_PENDING_BYTES;
  } else {
    cfg.eager_pull_pending_bytes = Number(cfg.eager_pull_pending_bytes);
  }
  if (Number.isNaN(cfg.eager_pull_pending_bytes) || cfg.eager_pull_pending_bytes < 0) {
    throw new Error("eager_pull_pending_bytes must be a non-negative number");
  }
  if (
    cfg.eager_pull_check_interval_seconds == null
    || cfg.eager_pull_check_interval_seconds === ""
  ) {
    cfg.eager_pull_check_interval_seconds = DEFAULT_EAGER_PULL_CHECK_INTERVAL_SECONDS;
  } else {
    cfg.eager_pull_check_interval_seconds = Number(cfg.eager_pull_check_interval_seconds);
  }
  if (
    Number.isNaN(cfg.eager_pull_check_interval_seconds)
    || cfg.eager_pull_check_interval_seconds <= 0
  ) {
    throw new Error("eager_pull_check_interval_seconds must be a positive number");
  }
  if (!cfg.ack_timeout_seconds || Number(cfg.ack_timeout_seconds) <= 0) {
    cfg.ack_timeout_seconds = 120;
  } else {
    cfg.ack_timeout_seconds = Number(cfg.ack_timeout_seconds);
  }
  if (!cfg.dup_name_strategy) {
    cfg.dup_name_strategy = "suffix-ts-counter";
  }
  if (cfg.dup_name_strategy !== "suffix-ts-counter") {
    throw new Error("dup_name_strategy only supports suffix-ts-counter");
  }

  if (!cfg.existing_file_strategy) {
    cfg.existing_file_strategy = "overwrite";
  }
  if (!["session_merge", "overwrite"].includes(cfg.existing_file_strategy)) {
    throw new Error("existing_file_strategy must be session_merge or overwrite");
  }

  cfg.dest_dir = cfg.raw_dir;
}

function buildBasicAuth(user, pass) {
  const raw = `${user}:${pass}`;
  const encoded = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function parseJsonMessage(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

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
  let value = String(first);
  value = value.replace(/\.json\.dup-\d+-\d+$/i, "");
  value = value.replace(/\.json$/i, "");
  return value || null;
}

async function applyDeletion(id) {
  if (!id) {
    return;
  }
  const target = safeJoin(config.raw_dir, id);
  await safeUnlink(target);
  await removeSiblingDupFiles(target);
  await removeEmptyParents(path.dirname(target), config.raw_dir);
}

async function removeSiblingDupFiles(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith(`${base}.dup-`)) {
      continue;
    }
    await safeUnlink(path.join(dir, entry.name));
  }
}

async function openFile(msg) {
  if (!msg || !msg.id) {
    throw new Error("invalid file_start");
  }
  const target = safeJoin(config.raw_dir, msg.id);
  await ensureDir(path.dirname(target));
  const tempPath = makeTempPath(target);
  const stream = fs.createWriteStream(tempPath, { flags: "w" });
  return {
    id: msg.id,
    idx: msg.idx,
    size: msg.size,
    received: 0,
    tempPath,
    targetPath: target,
    stream,
  };
}

async function writeChunk(fileState, chunk) {
  fileState.received += chunk.length;
  if (!fileState.stream.write(chunk)) {
    await onceDrain(fileState.stream);
  }
}

async function closeFile(fileState, msg) {
  await new Promise((resolve, reject) => {
    fileState.stream.once("error", reject);
    fileState.stream.end(() => resolve());
  });
  if (typeof msg.size === "number" && fileState.received !== msg.size) {
    await safeUnlink(fileState.tempPath);
    throw new Error("file size mismatch");
  }
  const targetExists = await pathExists(fileState.targetPath);
  if (!targetExists || config.existing_file_strategy === "overwrite") {
    await fs.promises.rename(fileState.tempPath, fileState.targetPath);
    return;
  }
  const finalTargetPath = await resolveFinalTargetPath(fileState.targetPath);
  await fs.promises.rename(fileState.tempPath, finalTargetPath);
  const sessionId = extractSessionIdFromFileId(fileState.id);
  if (!sessionId) {
    return;
  }
  try {
    const report = await rebuildSessionFromDup({
      sessionId,
      rawDir: config.raw_dir,
      reportsDir: config.reports_dir,
      safeUnlink,
      removeEmptyParents,
    });
    console.log(
      `[dup-rebuild] session=${report.session_id} sources=${report.source_file_count} events=${report.output_event_count} dedup_dropped=${report.dedup_dropped_count} conflicts=${report.conflict_count}`,
    );
  } catch (err) {
    console.error(`[dup-rebuild] session=${sessionId} failed`, err);
  }
}

async function resolveFinalTargetPath(targetPath) {
  if (!(await pathExists(targetPath))) {
    return targetPath;
  }
  let attempt = 1;
  while (true) {
    const candidate = `${targetPath}.dup-${Date.now()}-${attempt}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
    attempt += 1;
  }
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function onceDrain(stream) {
  return new Promise((resolve) => {
    stream.once("drain", resolve);
  });
}

function makeTempPath(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const rand = Math.random().toString(16).slice(2);
  return path.join(dir, `${base}.tmp-${process.pid}-${Date.now()}-${rand}`);
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
