const fs = require("fs");
const path = require("path");

function loadConfig(configPath) {
  if (!configPath) {
    throw new Error("Missing --config path");
  }
  const fullPath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

function getArgValue(argv, key) {
  const index = argv.indexOf(key);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] || null;
}

module.exports = {
  loadConfig,
  getArgValue,
};
