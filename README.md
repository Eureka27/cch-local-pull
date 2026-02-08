# cch-local-pull

Local pull client for claude-code-hub sessions. Incremental sync over WebSocket with Basic Auth.

## Features
- WebSocket server on the source host (session files).
- Client pulls deltas on a schedule (default 20 minutes).
- Incremental index based on mtimeMs + session_id.
- Bidirectional delete sync.
- Batch size limit per pull (default 3GB).
- Only `.json` files are synced from the session directory.

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
- `dest_dir`: target directory (e.g. `/path/to/cch-sessions`)
- `auth.user` / `auth.pass`

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
