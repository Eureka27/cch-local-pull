const fs = require("fs");
const path = require("path");

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const raw = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(filePath, raw, "utf8");
}

function safeJoin(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const parts = relPath.split("/").filter((p) => p.length > 0);
  const target = path.resolve(root, ...parts);
  if (target === root) {
    return target;
  }
  if (!target.startsWith(root + path.sep)) {
    throw new Error("Unsafe path detected");
  }
  return target;
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  safeJoin,
};
