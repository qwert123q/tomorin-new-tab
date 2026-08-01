# Tomorin New Tab Sync Server

This is an optional, dependency-free sync server for Tomorin New Tab.

It stores only lightweight extension metadata:

- shortcut title, URL, size, order, and icon source URL
- shortcut deletion tombstones
- icon density setting

Wallpaper images are stored separately and are transferred only when the user manually chooses upload or download in the extension.

It does not store shortcut icon image files.

## Run

```bash
export SYNC_TOKEN="change-me"
export SYNC_HOST=127.0.0.1
export SYNC_PORT=8787
export SYNC_DATA_FILE="$HOME/tomorin-new-tab-sync/data/state.json"
# Optional; defaults next to SYNC_DATA_FILE.
export SYNC_WALLPAPER_FILE="$HOME/tomorin-new-tab-sync/data/wallpaper.bin"
node server/sync-server.js
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

For direct IP testing, set `SYNC_HOST=0.0.0.0` and make sure the server firewall and cloud provider security group allow inbound TCP traffic on `SYNC_PORT`. For a domain setup, keep the sync server on `127.0.0.1` and expose it through an HTTPS reverse proxy such as Nginx.

When using Nginx, allow wallpaper request bodies up to the server limit in the relevant `server` or `location` block:

```nginx
client_max_body_size 100m;
```

## Chrome Extension

Open the new tab page, hover the gear, click the sync button, then enter:

- server URL, for example `https://sync.example.com`
- the same `SYNC_TOKEN`

The extension renders local data first and syncs in the background. Startup sync is rate-limited, and failed sync attempts leave local usage unaffected.

Wallpaper transfer is separate from background sync:

- **Upload local wallpaper** replaces the wallpaper currently stored on the sync server.
- **Download cloud wallpaper** replaces the wallpaper on the current device.
- Each wallpaper is limited to 100 MB.
- Upgrade the server and extension together before using wallpaper sync.

## Notes

The first version can run on plain HTTP for a private server IP. That keeps setup simple, but the token is not encrypted on the wire. Use HTTPS through a domain and reverse proxy when you add a domain later.
