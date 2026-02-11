# cch-local-pull

Local pull client for claude-code-hub sessions. Incremental sync over WebSocket with Basic Auth.

## Features
- WebSocket server on the source host (session files).
- Client pulls deltas on a schedule (default 20 minutes).
- Incremental index based on mtimeMs + session_id.
- Bidirectional delete sync.
- Batch size limit per pull (default 3GB).
- Only `.json` files are synced from the session directory.
- Client dual-path output:
  - `raw_dir`: raw pulled files (same-name collision saved as `.json.dup-*`)
  - `processed_dir`: rebuilt JSONL by `session_id` (single output file per session)
- Dedup/continuity check:
  - dedupe key = `requestSequence + type + payload`
  - strict sequence continuity = `1..max(requestSequence)`
  - incomplete sessions are written to `processed_dir/_incomplete/`

## Source Server (WS server)

1) Install and prepare config

```bash
cd /path/to/cch-local-pull
npm install
cp config/server.example.json config/server.json
```

Edit `config/server.json`:
- `session_dir`: source directory (e.g. `/path/to/session`)
- `auth.user` / `auth.pass`
- `port` (default 23050)
- `trash_dir`: trash directory for acked files (default `./trash`)
- `trash_ttl_days`: trash retention days (default `7`)
- `trash_cleanup_interval_seconds`: trash cleanup interval (default `600`)
- `trash_max_bytes`: trash size cap in bytes (default `5368709120`)
- `ack_timeout_seconds`: ack wait timeout (default `120`)
- `deletions_log_max_lines`: max lines kept in `state/deletions.jsonl` (default `200000`)
- `deletions_log_cleanup_interval_seconds`: deletions log compact interval (default `600`)

2) Start

```bash
npm run server
```

## Data Server (pull client)

1) Install and prepare config

```bash
cd /path/to/cch-local-pull
npm install
cp config/client.example.json config/client.json
```

Edit `config/client.json`:
- `server_url`: `ws://SOURCE_IP:23050`
- `raw_dir`: raw pull directory (e.g. `/path/to/cch-sessions/raw`)
- `processed_dir`: rebuilt output directory (e.g. `/path/to/cch-sessions/processed`)
- `reports_dir`: rebuild report directory (default `./state/reports`)
- `strict_sequence_start_at_one`: strict continuity check, default `true`
- `dup_name_strategy`: duplicate naming strategy, fixed as `suffix-ts-counter`
- `rebuild_concurrency`: session rebuild concurrency, default `2`
- `auth.user` / `auth.pass`
- `ack_timeout_seconds`: ack wait timeout (default `120`)

Compatibility note:
- Legacy `dest_dir` is still accepted and treated as `raw_dir` when `raw_dir` is not provided.

2) Start

```bash
node src/client.js --config config/client.json
```

## Notes
- Expose `23050/tcp` on source server firewall and cloud security group.
- `--once` runs a single pull:

```bash
node src/client.js --config config/client.json --once
```

Rebuild output behavior:
- If session is continuous: `processed_dir/<session_id>.json`
- If session is not continuous: `processed_dir/_incomplete/<session_id>.json`
- Per-session report: `reports_dir/<session_id>.json`
- Unchanged session inputs are skipped by in-memory rebuild cache

## Deploy (systemd)

Examples:
- `deploy/cch-pull-server.service.example`
- `deploy/cch-pull-client.service.example`

Source server (WS server):

```bash
sudo cp deploy/cch-pull-server.service.example /etc/systemd/system/cch-pull-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now cch-pull-server.service
```

Data server (pull client):

```bash
sudo cp deploy/cch-pull-client.service.example /etc/systemd/system/cch-pull-client.service
sudo systemctl daemon-reload
sudo systemctl enable --now cch-pull-client.service
```

Check status/logs:

```bash
sudo systemctl status cch-pull-server.service
sudo systemctl status cch-pull-client.service
sudo journalctl -u cch-pull-server.service -f
sudo journalctl -u cch-pull-client.service -f
```
