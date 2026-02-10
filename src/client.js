const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const { loadConfig, getArgValue } = require("./shared/config");
const { ensureDir, readJson, writeJson, safeJoin } = require("./shared/fs");
const { normalizeIdx } = require("./shared/idx");

const argv = process.argv.slice(2);
const configPath = getArgValue(argv, "--config") || "config/client.json";
const runOnce = argv.includes("--once");
const config = loadConfig(configPath);
const REQUEST_SHARD_FILE_REGEX = /^([^/]+)\/req-(\d+)\.json$/;

validateConfig(config);

const stateDir = path.resolve(process.cwd(), path.dirname(config.last_idx_path));
const mergeStateDir = path.resolve(process.cwd(), path.dirname(config.merge_state_path));
let pulling = false;

start();

async function start() {
  await ensureDir(config.dest_dir);
  await ensureDir(stateDir);
  if (config.enable_session_merge) {
    await ensureDir(config.merged_dir);
    await ensureDir(mergeStateDir);
  }

  await pullOnce();

  if (runOnce) {
    return;
  }

  const intervalMs = (config.pull_interval_seconds || 1200) * 1000;
  setInterval(() => {
    if (!pulling) {
      pullOnce();
    }
  }, intervalMs);
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
    const changedSessions = new Set();

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
            await applyDeletion(del.id);
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
        markChangedSession(changedSessions, currentFile.id);
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
          await mergeChangedSessions(changedSessions);
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
        await mergeChangedSessions(changedSessions);
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

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("Invalid config");
  }
  if (!cfg.server_url) {
    throw new Error("server_url is required");
  }
  if (!cfg.dest_dir) {
    throw new Error("dest_dir is required");
  }
  if (!cfg.auth || !cfg.auth.user || !cfg.auth.pass) {
    throw new Error("auth.user and auth.pass are required");
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
    cfg.pull_interval_seconds = 1200;
  } else {
    cfg.pull_interval_seconds = Number(cfg.pull_interval_seconds);
  }
  if (!cfg.ack_timeout_seconds || Number(cfg.ack_timeout_seconds) <= 0) {
    cfg.ack_timeout_seconds = 120;
  } else {
    cfg.ack_timeout_seconds = Number(cfg.ack_timeout_seconds);
  }
  cfg.enable_session_merge = Boolean(cfg.enable_session_merge);
  if (!cfg.merged_dir) {
    cfg.merged_dir = path.join(cfg.dest_dir, "_merged");
  }
  if (!cfg.merge_state_path) {
    cfg.merge_state_path = "./state/merge_state.json";
  }
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

async function applyDeletion(id) {
  if (!id) {
    return;
  }
  try {
    const target = safeJoin(config.dest_dir, id);
    await fs.promises.unlink(target);
    await removeEmptyParents(path.dirname(target));
  } catch (err) {
    return;
  }
}

async function openFile(msg) {
  if (!msg || !msg.id) {
    throw new Error("invalid file_start");
  }
  const target = safeJoin(config.dest_dir, msg.id);
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
  await fs.promises.rename(fileState.tempPath, fileState.targetPath);
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

async function removeEmptyParents(startDir) {
  const root = path.resolve(config.dest_dir);
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

function markChangedSession(changedSessions, fileId) {
  const parsed = parseRequestShardId(fileId);
  if (!parsed) {
    return;
  }
  changedSessions.add(parsed.sessionId);
}

function parseRequestShardId(fileId) {
  if (!fileId || typeof fileId !== "string") {
    return null;
  }
  const normalized = fileId.split(path.sep).join("/");
  const match = normalized.match(REQUEST_SHARD_FILE_REGEX);
  if (!match) {
    return null;
  }
  return {
    sessionId: match[1],
    seq: Number(match[2]),
  };
}

async function mergeChangedSessions(changedSessions) {
  if (!config.enable_session_merge || changedSessions.size === 0) {
    return;
  }

  try {
    let mergeState = await readJson(config.merge_state_path, {});
    if (!mergeState || typeof mergeState !== "object" || Array.isArray(mergeState)) {
      mergeState = {};
    }

    const sessionIds = Array.from(changedSessions).sort();
    for (const sessionId of sessionIds) {
      try {
        await mergeOneSession(sessionId, mergeState);
      } catch (err) {
        console.error(`session merge failed: ${sessionId}`, err);
      }
    }

    await writeJson(config.merge_state_path, mergeState);
  } catch (err) {
    console.error("session merge pipeline failed", err);
  }
}

async function mergeOneSession(sessionId, mergeState) {
  const sessionDir = safeJoin(config.dest_dir, sessionId);
  let dirEntries = [];
  try {
    dirEntries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }

  const shards = dirEntries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(/^req-(\d+)\.json$/);
      if (!match) {
        return null;
      }
      return {
        seq: Number(match[1]),
        path: path.join(sessionDir, entry.name),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);

  if (shards.length === 0) {
    return;
  }

  const mergedPath = safeJoin(config.merged_dir, `${sessionId}.json`);
  const maxSeq = shards[shards.length - 1].seq;
  const currentState = mergeState[sessionId];
  const lastMergedSeq = Number(currentState?.last_merged_seq || 0);
  if (lastMergedSeq >= maxSeq && await fileExists(mergedPath)) {
    return;
  }

  await ensureDir(path.dirname(mergedPath));
  const tempPath = makeTempPath(mergedPath);

  try {
    const stream = fs.createWriteStream(tempPath, { flags: "w" });
    for (const shard of shards) {
      await appendFileToStream(stream, shard.path);
    }
    await endWriteStream(stream);
    await fs.promises.rename(tempPath, mergedPath);
  } catch (err) {
    await safeUnlink(tempPath);
    throw err;
  }

  mergeState[sessionId] = {
    last_merged_seq: maxSeq,
    shard_count: shards.length,
    merged_at: new Date().toISOString(),
  };
}

async function appendFileToStream(stream, sourcePath) {
  const reader = fs.createReadStream(sourcePath);
  for await (const chunk of reader) {
    if (!stream.write(chunk)) {
      await onceDrain(stream);
    }
  }
}

async function endWriteStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (err) {
    return false;
  }
}
