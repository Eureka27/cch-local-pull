#!/usr/bin/env bash
set -euo pipefail

# ===================== User Config (edit here) =====================
DEPLOY_MODE="server"          # server | client
DEPLOY_USER="ubuntu"          # systemd User=
SERVER_HOST="0.0.0.0"
SERVER_PORT="30511"
SESSION_DIR="./session"
SERVER_AUTH_USER="pull"
SERVER_AUTH_PASS="CHANGE_ME"

CLIENT_SERVER_URL="ws://127.0.0.1:30511"
CLIENT_AUTH_USER="pull"
CLIENT_AUTH_PASS="CHANGE_ME"
CLIENT_RAW_DIR="./cch-sessions/raw"
CLIENT_REPORTS_DIR="./cch-sessions/reports"
# ================================================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_DIR="/etc/systemd/system"

SESSION_DIR_ABS=""
CLIENT_RAW_DIR_ABS=""
CLIENT_REPORTS_DIR_ABS=""

log() {
  echo "[cch-local-pull][deploy] $*"
}

fail() {
  echo "[cch-local-pull][deploy] ERROR: $*" >&2
  exit 1
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "root or sudo is required for: $*"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

resolve_path() {
  local p="$1"
  if [[ "${p}" = /* ]]; then
    printf '%s\n' "${p}"
  else
    printf '%s/%s\n' "${REPO_ROOT}" "${p#./}"
  fi
}

validate_mode() {
  case "${DEPLOY_MODE}" in
    server|client) ;;
    *) fail "DEPLOY_MODE must be server|client" ;;
  esac
}

check_node() {
  local node_major
  node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  [[ "${node_major}" -ge 18 ]] || fail "node >= 18 is required"
}

validate_config() {
  [[ -n "${SESSION_DIR}" ]] || fail "SESSION_DIR cannot be empty"
  [[ -n "${CLIENT_SERVER_URL}" ]] || fail "CLIENT_SERVER_URL cannot be empty"
  [[ -n "${CLIENT_RAW_DIR}" ]] || fail "CLIENT_RAW_DIR cannot be empty"
  [[ -n "${CLIENT_REPORTS_DIR}" ]] || fail "CLIENT_REPORTS_DIR cannot be empty"

  if [[ "${SERVER_AUTH_PASS}" == "CHANGE_ME" || "${CLIENT_AUTH_PASS}" == "CHANGE_ME" ]]; then
    fail "please replace CHANGE_ME with real auth password in script config"
  fi

  SESSION_DIR_ABS="$(resolve_path "${SESSION_DIR}")"
  CLIENT_RAW_DIR_ABS="$(resolve_path "${CLIENT_RAW_DIR}")"
  CLIENT_REPORTS_DIR_ABS="$(resolve_path "${CLIENT_REPORTS_DIR}")"
}

write_server_config() {
  mkdir -p "${REPO_ROOT}/config" "${REPO_ROOT}/state" "${REPO_ROOT}/trash"

  cat > "${REPO_ROOT}/config/server.json" <<JSON
{
  "host": "${SERVER_HOST}",
  "port": ${SERVER_PORT},
  "session_dir": "${SESSION_DIR_ABS}",
  "state_dir": "${REPO_ROOT}/state",
  "trash_dir": "${REPO_ROOT}/trash",
  "trash_ttl_days": 7,
  "trash_cleanup_interval_seconds": 600,
  "trash_max_bytes": 5368709120,
  "auth": {
    "user": "${SERVER_AUTH_USER}",
    "pass": "${SERVER_AUTH_PASS}"
  },
  "max_batch_bytes": 3221225472,
  "chunk_bytes": 1048576,
  "ack_timeout_seconds": 120,
  "deletions_log_max_lines": 200000,
  "deletions_log_cleanup_interval_seconds": 600
}
JSON
}

write_client_config() {
  mkdir -p "${REPO_ROOT}/config" "${REPO_ROOT}/state"
  mkdir -p "${CLIENT_RAW_DIR_ABS}" "${CLIENT_REPORTS_DIR_ABS}"

  cat > "${REPO_ROOT}/config/client.json" <<JSON
{
  "server_url": "${CLIENT_SERVER_URL}",
  "auth": {
    "user": "${CLIENT_AUTH_USER}",
    "pass": "${CLIENT_AUTH_PASS}"
  },
  "raw_dir": "${CLIENT_RAW_DIR_ABS}",
  "reports_dir": "${CLIENT_REPORTS_DIR_ABS}",
  "dup_name_strategy": "suffix-ts-counter",
  "last_idx_path": "${REPO_ROOT}/state/last_idx.json",
  "pull_interval_seconds": 1200,
  "max_batch_bytes": 3221225472,
  "ack_timeout_seconds": 120
}
JSON
}

install_server_service() {
  local service_path="${SERVICE_DIR}/cch-pull-server.service"
  local tmp_unit
  tmp_unit="$(mktemp)"
  trap 'rm -f "${tmp_unit}"' RETURN

  cat > "${tmp_unit}" <<UNIT
[Unit]
Description=CCH Local Pull WebSocket Server
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${REPO_ROOT}
ExecStart=/usr/bin/env node ${REPO_ROOT}/src/server.js --config ${REPO_ROOT}/config/server.json
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  run_root install -m 0644 "${tmp_unit}" "${service_path}"
  run_root systemctl daemon-reload
  run_root systemctl enable --now cch-pull-server.service
  run_root systemctl --no-pager --full status cch-pull-server.service || true
}

install_client_service() {
  local service_path="${SERVICE_DIR}/cch-pull-client.service"
  local tmp_unit
  tmp_unit="$(mktemp)"
  trap 'rm -f "${tmp_unit}"' RETURN

  cat > "${tmp_unit}" <<UNIT
[Unit]
Description=CCH Local Pull Client
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${REPO_ROOT}
ExecStart=/usr/bin/env node ${REPO_ROOT}/src/client.js --config ${REPO_ROOT}/config/client.json
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  run_root install -m 0644 "${tmp_unit}" "${service_path}"
  run_root systemctl daemon-reload
  run_root systemctl enable --now cch-pull-client.service
  run_root systemctl --no-pager --full status cch-pull-client.service || true
}

main() {
  validate_mode
  validate_config
  require_cmd node
  require_cmd npm
  require_cmd systemctl
  check_node

  log "installing npm dependencies"
  npm --prefix "${REPO_ROOT}" install

  if [[ "${DEPLOY_MODE}" == "server" ]]; then
    log "writing config/server.json"
    write_server_config
    log "installing cch-pull-server.service"
    install_server_service
  fi

  if [[ "${DEPLOY_MODE}" == "client" ]]; then
    log "writing config/client.json"
    write_client_config
    log "installing cch-pull-client.service"
    install_client_service
  fi

  log "done"
}

main "$@"
