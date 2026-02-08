const fs = require("fs");
const path = require("path");

async function listFiles(rootDir) {
  const results = [];
  const root = path.resolve(rootDir);

  async function walk(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.promises.stat(fullPath);
      const rel = path.relative(root, fullPath);
      if (!rel || rel.startsWith("..")) {
        continue;
      }
      results.push({
        id: rel.split(path.sep).join("/"),
        absPath: fullPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  await walk(root);
  return results;
}

module.exports = {
  listFiles,
};
