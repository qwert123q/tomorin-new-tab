# Tomorin New Tab Sync Server

This is an optional, dependency-free sync server for Tomorin New Tab.

It stores only lightweight extension metadata:

- shortcut title, URL, size, order, and icon source URL
- shortcut deletion tombstones
- icon density setting

It does not store wallpaper image files or shortcut icon image files.

## Run

```bash
export SYNC_TOKEN="change-me"
export SYNC_PORT=8787
export SYNC_DATA_FILE="$HOME/tomorin-new-tab-sync/data/state.json"
node server/sync-server.js
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Chrome Extension

Open the new tab page, hover the gear, click the sync button, then enter:

- server URL, for example `http://YOUR_SERVER_IP:8787`
- the same `SYNC_TOKEN`

The extension renders local data first and syncs in the background. Startup sync is rate-limited, and failed sync attempts leave local usage unaffected.

## Notes

The first version can run on plain HTTP for a private server IP. That keeps setup simple, but the token is not encrypted on the wire. Use HTTPS through a domain and reverse proxy when you add a domain later.
