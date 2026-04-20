# cch-local-pull

`cch-local-pull` transfers exported session and database files from a source host to a data host over WebSocket with Basic Auth. It supports incremental sync, delete propagation, path-based write strategies, and source-side trash management for acknowledged files.

## Overview

- A source server exposes a pull endpoint over WebSocket.
- A pull client connects to the source server and fetches file deltas.
- File updates are tracked by `mtimeMs + relative file id`.
- Delete events are propagated to the client.
- Source files that have been acknowledged by the client are moved into `trash`.

## Server Behavior

The source server reads files from `session_dir` and serves matching files to authenticated clients.

Key characteristics:

- Supported extensions are configurable, for example `.json` and `.jsonl`.
- Excluded prefixes are configurable, for example `state/`.
- Acknowledged source files are moved into `trash`.
- Trash cleanup runs as a background task.
- The default trash cleanup interval is `60` seconds.
- The default trash size cap is `3221225472` bytes (`3 GiB`).
- If trash grows beyond the configured cap, a full trash cleanup may be used as the final fallback.
- Under `trash/db/...`, only the latest file for each logical path is retained.
- Historical `trash/db/*.dup-*` files are pruned during cleanup.
- Non-`db` paths keep their existing duplicate naming behavior.

## Client Behavior

The pull client stores files under `raw_dir` and applies a write strategy based on path rules.

Key characteristics:

- The default scheduled pull interval is `7200` seconds.
- The client can probe pending source-side bytes and trigger an earlier pull when the configured threshold is reached.
- Pull batches are limited by `max_batch_bytes`.
- The client tracks the last acknowledged index in `last_idx_path`.
- `jsonl_merge` tracks already applied source versions in `jsonl_merge_state_path`.
- Startup cleanup removes orphaned managed `*.tmp-*` files that belong to dead processes.
- Successful session rebuilds also clean managed `tmp` files for the rebuilt session and its report.

## Write Strategies

### `overwrite`

Use `overwrite` for paths that should always be treated as complete latest snapshots.

Behavior:

- If the target file does not exist, the client stores the incoming file directly.
- If the target file already exists, the incoming file replaces it.

### `session_merge`

Use `session_merge` for session event streams where the same logical session may be pulled multiple times and needs to be rebuilt into one canonical file.

Behavior:

- The first pulled file is stored directly as `<session_id>.json`.
- Later versions of the same session are stored as temporary duplicate inputs.
- The client rebuilds one canonical `<session_id>.json`.
- The rebuild uses:
  - dedupe key: `requestSequence + type + payload`
  - conflict key: `requestSequence + type`
  - newer source wins on conflicts
- Duplicate input files are removed after a successful rebuild.
- A per-session report is written under `reports_dir`.

### `jsonl_merge`

Use `jsonl_merge` for append-only exporter outputs such as:

- `db/`
- `redis/request_sidecars/`

Behavior:

- Each new source file version is appended to the local target file.
- The same source version is not appended twice on retry.

## Example Layout

Typical exporter-root layout on the source side:

```text
export/
  redis/
    session_events/
    request_sidecars/
  db/
```

Typical client layout:

```text
pulled/
  export/
state/
  last_idx.json
  jsonl_merge_state.json
  reports/
trash/
```

## Configuration

### Server

Example:

```json
{
  "host": "0.0.0.0",
  "port": 23050,
  "session_dir": "./export",
  "include_extensions": [".json", ".jsonl"],
  "exclude_prefixes": ["state/"],
  "state_dir": "./state",
  "trash_dir": "./trash",
  "trash_ttl_days": 7,
  "trash_cleanup_interval_seconds": 60,
  "trash_max_bytes": 3221225472,
  "auth": {
    "user": "pull",
    "pass": "CHANGE_ME"
  },
  "max_batch_bytes": 3221225472,
  "chunk_bytes": 1048576,
  "ack_timeout_seconds": 120,
  "deletions_log_max_lines": 200000,
  "deletions_log_cleanup_interval_seconds": 600
}
```

Important fields:

- `session_dir`
- `include_extensions`
- `exclude_prefixes`
- `state_dir`
- `trash_dir`
- `trash_ttl_days`
- `trash_cleanup_interval_seconds`
- `trash_max_bytes`
- `auth.user`
- `auth.pass`
- `max_batch_bytes`
- `chunk_bytes`
- `ack_timeout_seconds`

### Client

Example:

```json
{
  "server_url": "ws://source.example.com:23050",
  "auth": {
    "user": "pull",
    "pass": "CHANGE_ME"
  },
  "raw_dir": "./pulled/export",
  "reports_dir": "./state/reports",
  "existing_file_strategy": "overwrite",
  "session_merge_prefixes": ["redis/session_events/"],
  "jsonl_merge_prefixes": ["redis/request_sidecars/", "db/"],
  "dup_name_strategy": "suffix-ts-counter",
  "last_idx_path": "./state/last_idx.json",
  "jsonl_merge_state_path": "./state/jsonl_merge_state.json",
  "pull_interval_seconds": 7200,
  "eager_pull_pending_bytes": 2147483648,
  "eager_pull_check_interval_seconds": 60,
  "max_batch_bytes": 3221225472,
  "ack_timeout_seconds": 120
}
```

Important fields:

- `server_url`
- `auth.user`
- `auth.pass`
- `raw_dir`
- `reports_dir`
- `existing_file_strategy`
- `session_merge_prefixes`
- `jsonl_merge_prefixes`
- `last_idx_path`
- `jsonl_merge_state_path`
- `pull_interval_seconds`
- `eager_pull_pending_bytes`
- `eager_pull_check_interval_seconds`
- `max_batch_bytes`
- `ack_timeout_seconds`

## One-Click Deploy

Edit the variables at the top of `deploy/deploy-oneclick.sh`, then run:

```bash
bash deploy/deploy-oneclick.sh
```

Common variables:

- `DEPLOY_MODE`
- `SESSION_DIR`
- `SERVER_INCLUDE_EXTENSIONS`
- `SERVER_EXCLUDE_PREFIXES`
- `CLIENT_SERVER_URL`
- `CLIENT_RAW_DIR`
- `CLIENT_REPORTS_DIR`
- `CLIENT_EXISTING_FILE_STRATEGY`
- `CLIENT_SESSION_MERGE_PREFIXES`
- `CLIENT_JSONL_MERGE_PREFIXES`
- `CLIENT_PULL_INTERVAL_SECONDS`
- `CLIENT_EAGER_PULL_PENDING_BYTES`
- `CLIENT_EAGER_PULL_CHECK_INTERVAL_SECONDS`

## Manual Start

Install dependencies:

```bash
cd /path/to/cch-local-pull
npm install
```

Start the server:

```bash
node src/server.js --config config/server.json
```

Start the client:

```bash
node src/client.js --config config/client.json
```

Run the client once:

```bash
node src/client.js --config config/client.json --once
```

## Systemd

Example unit files:

- `deploy/cch-pull-server.service.example`
- `deploy/cch-pull-client.service.example`

Install example units:

```bash
sudo cp deploy/cch-pull-server.service.example /etc/systemd/system/cch-pull-server.service
sudo cp deploy/cch-pull-client.service.example /etc/systemd/system/cch-pull-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now cch-pull-server.service
sudo systemctl enable --now cch-pull-client.service
```

Check status and logs:

```bash
sudo systemctl status cch-pull-server.service
sudo systemctl status cch-pull-client.service
sudo journalctl -u cch-pull-server.service -f
sudo journalctl -u cch-pull-client.service -f
```
