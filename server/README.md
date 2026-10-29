# Tomorin New Tab Sync Server

An optional, dependency-free sync server for Tomorin New Tab (protocol v2, needs Node 18 or newer).

It keeps one document with every shortcut (title, URL, size, position, icon choice), deletion records, the icon density and which wallpaper is active, plus the wallpaper and uploaded icon images as files named by their SHA-256 hash. Icons the extension finds automatically are not uploaded; each computer finds them itself.

How it avoids overwriting:

- Every write names the revision it was based on (`If-Match`). If another computer wrote in between, the server answers `412`, the extension merges the newer copy and tries again.
- The extension merges per shortcut and per part (content vs. position), so changes made on different computers combine instead of replacing each other.
- A picture is uploaded once; the document only refers to its hash, and the server answers `409` with the missing hashes when a document refers to a picture it does not have yet.

## Run

```bash
export SYNC_PASSWORD="a password you can remember"
export SYNC_HOST=127.0.0.1
export SYNC_PORT=8787
export SYNC_DATA_DIR="$HOME/tomorin-new-tab-sync/data"
node server/sync-server.js
```

Health check:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"protocol":2,...}
```

Settings:

| Variable | Meaning |
| --- | --- |
| `SYNC_PASSWORD` | The password entered in the extension. Pick something you can remember (10+ characters). |
| `SYNC_TOKEN` | The older token; still accepted, so you can keep it while moving to `SYNC_PASSWORD`. At least one of the two is required. |
| `SYNC_HOST`, `SYNC_PORT` | Listen address, default `0.0.0.0:8787`. Use `127.0.0.1` behind a reverse proxy. |
| `SYNC_DATA_DIR` | Data folder. If unset, the folder of the older `SYNC_DATA_FILE` is used, else `server/data`. |
| `SYNC_MAX_FAILURES_PER_IP` | Wrong passwords allowed per address per 15 minutes before sign-in pauses for it (default 10). |
| `SYNC_MAX_FAILURES_TOTAL` | Wrong passwords allowed from all addresses per 15 minutes (default 100). |
| `SYNC_TRUST_PROXY` | Set to `0` to ignore `X-Real-IP` / `X-Forwarded-For` from a local reverse proxy. |

Data files in `SYNC_DATA_DIR`:

- `state-v2.json`: the shortcut document and its revision.
- `blobs/`: wallpaper and uploaded icon images. Pictures no longer used are removed a day after they stop being referenced.

The version 1 files (`state.json`, `wallpaper.bin`) are no longer read. They are left untouched as a backup and can be deleted once every computer has synced.

## Reverse proxy

For a domain, keep the server on `127.0.0.1` and expose it through HTTPS, for example with Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 100m;
}
```

`client_max_body_size` must allow wallpaper uploads (up to 100 MB). `X-Real-IP` lets the server rate-limit wrong passwords per visitor instead of treating every request as coming from the proxy.

For direct IP testing, set `SYNC_HOST=0.0.0.0` and allow inbound TCP traffic on `SYNC_PORT`. Plain HTTP sends the password unencrypted, so use HTTPS for anything beyond a quick test.

## Upgrading from version 1

1. Copy the new `server/sync-server.js` over the old one.
2. Add `SYNC_PASSWORD=...` to the server's environment (for systemd, the `EnvironmentFile`). Keeping `SYNC_TOKEN` is fine.
3. Restart the service and check that `/health` reports `"protocol":2`.
4. Update the extension on your main computer first and let it sync: it becomes the starting cloud copy. On the other computers, choose **使用云端数据** (use cloud data) when asked.

Extensions that are still on version 1 get `410 client_outdated` and stop syncing until they are updated, so they cannot overwrite the new data.

## API

All `/api/v2/*` requests need `Authorization: Bearer <password>`; the extension percent-encodes the password so it may contain any characters.

| Request | Result |
| --- | --- |
| `GET /api/v2/state` | `{ rev, state }`, or `304` when `If-None-Match` matches the current revision. |
| `PUT /api/v2/state` with `If-Match: "<rev>"` | `{ rev }`; `412` with the current `rev` on a conflict; `409 { missing }` when images must be uploaded first; `428` without `If-Match`. |
| `GET /api/v2/blobs/<sha256>` | The image. |
| `PUT /api/v2/blobs/<sha256>` | Stores an image (`image/*`, not SVG, up to 100 MB) after checking its hash. |
