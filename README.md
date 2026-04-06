# cch-local-pull

Local pull toolkit for `claude-code-hub` exported data and flat session JSON files. It syncs files incrementally over WebSocket with Basic Auth.

## Features
- WebSocket server on the source host.
- Incremental sync based on `mtimeMs + relative file id`.
- Bidirectional delete sync.
- Scheduled pull interval defaults to `2 hours`.
- If pending source-side changes since the last acknowledged pull reach `2GiB`, the client probes and triggers an immediate pull without waiting for the full interval.
- Batch size limit per pull (default `3GB`).
- Configurable extension filter, for example `.json` and `.jsonl`.
- Optional path-prefix exclusions, for example `state/`.
- Three write strategies on the client:
  - `overwrite`: replace the local file with the source file. This is the default and the recommended mode for exporter roots such as `./export`.
  - `session_merge`: keep duplicate session JSON files, rebuild a canonical `<session_id>.json`, and write a report when a rebuild happens.
  - `jsonl_merge`: append new source file versions to the local target file while skipping re-appends of the same source file version.
- Path-based overrides are supported, so one subtree such as `redis/session_events/` can use `session_merge`, while `redis/request_sidecars/` and `db/` use `jsonl_merge`.

## One-click Deploy

Edit the variables at the top of `deploy/deploy-oneclick.sh`, then run:

```bash
bash deploy/deploy-oneclick.sh
```

Important variables in `deploy/deploy-oneclick.sh`:
- `DEPLOY_MODE`: `server` or `client`
- `SESSION_DIR`: source root such as `./export` or `./session`
- `SERVER_INCLUDE_EXTENSIONS`: for example `[".json",".jsonl"]`
- `SERVER_EXCLUDE_PREFIXES`: for example `["state/"]`
- `CLIENT_SERVER_URL`
- `CLIENT_RAW_DIR`
- `CLIENT_REPORTS_DIR`
- `CLIENT_EXISTING_FILE_STRATEGY`: `overwrite`, `session_merge` or `jsonl_merge`
- `CLIENT_SESSION_MERGE_PREFIXES`: default `["redis/session_events/"]`
- `CLIENT_JSONL_MERGE_PREFIXES`: default `["redis/request_sidecars/","db/"]`
- `CLIENT_PULL_INTERVAL_SECONDS`: default `7200`
- `CLIENT_EAGER_PULL_PENDING_BYTES`: default `2147483648` (`2GiB`)
- `CLIENT_EAGER_PULL_CHECK_INTERVAL_SECONDS`: default `60`

Relative paths in the script are resolved from the repository root.

## Source Server

Install and prepare config:

```bash
cd /path/to/cch-local-pull
npm install
cp config/server.example.json config/server.json
```

Key fields in `config/server.json`:
- `session_dir`: source root. It can be a flat session directory such as `./session` or an exporter root such as `./export`.
- `include_extensions`: allowed file extensions.
- `exclude_prefixes`: excluded relative prefixes inside `session_dir`.
- `auth.user` / `auth.pass`
- `port`
- `state_dir`
- `trash_dir`
- `trash_ttl_days`
- `trash_cleanup_interval_seconds`
- `trash_max_bytes`
- `ack_timeout_seconds`
- `deletions_log_max_lines`
- `deletions_log_cleanup_interval_seconds`

Typical exporter-root server config:

```json
{
  "session_dir": "./export",
  "include_extensions": [".json", ".jsonl"],
  "exclude_prefixes": ["state/"]
}
```

Start the server:

```bash
npm run server
```

## Pull Client

Install and prepare config:

```bash
cd /path/to/cch-local-pull
npm install
cp config/client.example.json config/client.json
```

Key fields in `config/client.json`:
- `server_url`: for example `ws://source.example.com:23050`
- `raw_dir`: local destination root for pulled files
- `reports_dir`: report directory used by `session_merge`
- `existing_file_strategy`: `overwrite`, `session_merge` or `jsonl_merge`
- `session_merge_prefixes`: relative directory prefixes that force `session_merge`, for example `["redis/session_events/"]`
- `jsonl_merge_prefixes`: relative directory prefixes that force `jsonl_merge`, for example `["redis/request_sidecars/", "db/"]`
- `dup_name_strategy`: fixed as `suffix-ts-counter`
- `auth.user` / `auth.pass`
- `last_idx_path`
- `jsonl_merge_state_path`: local state file used to avoid re-appending the same source file version
- `pull_interval_seconds`: scheduled full-pull interval, default `7200`
- `eager_pull_pending_bytes`: source-side pending-byte threshold for immediate pull, default `2147483648` (`2GiB`)
- `eager_pull_check_interval_seconds`: summary probe interval, default `60`
- `max_batch_bytes`
- `ack_timeout_seconds`

Typical exporter-root client config:

```json
{
  "raw_dir": "./pulled/export",
  "existing_file_strategy": "overwrite",
  "session_merge_prefixes": ["redis/session_events/"],
  "jsonl_merge_prefixes": ["redis/request_sidecars/", "db/"],
  "pull_interval_seconds": 7200,
  "eager_pull_pending_bytes": 2147483648
}
```

In exporter-root mode, a practical setup is:
- `redis/session_events/` uses `session_merge`
- `redis/request_sidecars/` uses `jsonl_merge`
- `db/` uses `jsonl_merge`

If the source side is a flat per-session JSON directory, you can still set `existing_file_strategy` to `session_merge` for the whole pull root and omit `session_merge_prefixes`.

Compatibility note:
- Legacy `dest_dir` is still accepted and treated as `raw_dir` when `raw_dir` is not provided.

Start the client:

```bash
node src/client.js --config config/client.json
```

Run once:

```bash
node src/client.js --config config/client.json --once
```

`eager_pull_pending_bytes` is based on pending source-side upsert bytes since the last acknowledged index, not on the total size of `raw_dir`.

## Write Strategies

- `overwrite`
  - What it does: replace the local file with the latest source file.
  - Use it for: files that should always be treated as complete latest snapshots.

- `session_merge`
  - What it does: keep duplicate session JSON files temporarily, then rebuild one canonical `<session_id>.json`.
  - Use it for: session event streams where the same session file may be pulled multiple times and should be merged back into one timeline, such as `redis/session_events/`, or a flat per-session JSON directory.

- `jsonl_merge`
  - What it does: append each new source file version to the local target file and skip re-appending the same source file version on retry.
  - Use it for: append-only exporter files that should keep full history across pulls, such as `db/` daily JSONL files and `redis/request_sidecars/`.

## Dup Repair

`session_merge` rebuilds files with these rules:
- Dedupe key: `requestSequence + type + payload`
- Conflict key: `requestSequence + type`, newer source wins
- Duplicate inputs are written as `.dup-*` files before rebuild
- Reports are written only when rebuild is triggered

## Deploy

Example units:
- `deploy/cch-pull-server.service.example`
- `deploy/cch-pull-client.service.example`

Install the source server unit:

```bash
sudo cp deploy/cch-pull-server.service.example /etc/systemd/system/cch-pull-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now cch-pull-server.service
```

Install the pull client unit:

```bash
sudo cp deploy/cch-pull-client.service.example /etc/systemd/system/cch-pull-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now cch-pull-client.service
```

Check status and logs:

```bash
sudo systemctl status cch-pull-server.service
sudo systemctl status cch-pull-client.service
sudo journalctl -u cch-pull-server.service -f
sudo journalctl -u cch-pull-client.service -f
```
