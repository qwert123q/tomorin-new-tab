# Tomorin New Tab

English | [简体中文](README.zh-CN.md)

Tomorin New Tab is a lightweight, local-first Chrome new tab extension inspired by Infinity New Tab.

## Screenshot

![Tomorin New Tab example](docs/assets/example.png)

## Features

- Replaces Chrome's new tab page.
- Uses Chrome's default search engine through the `chrome.search` API, or Bing.
- Opens typed URLs directly.
- Shows paginated favorite website shortcuts, starting with a small generic set.
- Switches global icon density between small, medium, and large.
- Keeps controls tucked behind a hover/focus gear menu.
- Keeps uploaded wallpapers sharp at close to 4K resolution.
- Keeps shortcut icon sizes stable across common laptop resolutions and Windows scaling.
- Does not use an account, analytics, hosted project backend, or wallpaper API.

### Icons

- Picks the sharpest icon each site offers. It checks icons declared by the page, the web app manifest, Apple touch icons, the Google and DuckDuckGo favicon services, and the mobile site when everything else is small. Every candidate is downloaded and measured, and the largest square one wins.
- Icons are shown the way the site drew them: empty transparent margins are trimmed, rounded-square and round icons fill the tile, and transparent logos stay transparent. Nothing is drawn behind them.
- Sites without any icon get a coloured tile with the first character of their name.
- The edit dialog offers Auto, every distinct candidate with its size, a letter tile, or your own upload.
- Icons are cached in IndexedDB. Looking up icons only touches that cache: it never changes your shortcuts and never causes sync traffic.

### Editing

- Right-click (two-finger click on a trackpad) a shortcut to enter edit mode: drag to reorder, click to edit, remove with the corner badge (with undo), and click anywhere outside the icons to finish.
- To move a shortcut to another page, hold it beside the grid (or over a page dot) while dragging until the page turns, then drop it into a slot.
- The last slot in edit mode is an **Add** tile that matches the other icons.

### Optional self-hosted sync

Keeps shortcuts, their order, icon choices, uploaded icons, icon density and the wallpaper the same on every computer, through a small server you run yourself.

- On a new computer you only enter the server address and the sync password you chose on the server.
- A fresh install takes the cloud copy; its default shortcuts never reach the cloud.
- The first time a computer with different shortcuts syncs, you choose: use the cloud copy, merge both, or use this computer's copy. Nothing is overwritten silently.
- After that each part of a shortcut merges on its own: a rename on one computer and a move on another both survive, and two computers syncing at the same moment cannot overwrite each other.
- Wallpapers and uploaded icons are uploaded once by content hash and downloaded only by computers that are missing them.
- Before the first sync replaces local data, or a sync removes several shortcuts, a local backup is kept and can be brought back from sync settings.

See [server/README.md](server/README.md) for setup.

## Install Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/` folder.
5. Open a new tab.

## Package

Create a distributable zip:

```bash
./scripts/package-extension.sh
```

The zip file is written to `dist/`. See [docs/release.md](docs/release.md) for release and Chrome Web Store notes.

## Upgrading From 0.1.x

- Local data is migrated the first time a new tab opens. Previously cached icons keep showing until a sharper one is found.
- The sync protocol changed: update the sync server first, then the extension on each computer. The old access token still works as the sync password.
- Upgrade and sync your main computer first so its shortcuts become the starting cloud copy, then choose **Use cloud data** on the other computers.

## Local Data

Shortcuts, their order and settings are saved in Chrome extension local storage. Wallpaper and icon images are saved in the extension's IndexedDB database. Both are local to the current Chrome profile and are removed when the extension is removed. If sync is enabled, the same data, including the wallpaper and uploaded icons, is sent to the sync server you configured.

See [PRIVACY.md](PRIVACY.md) for details.

## License

MIT. See [LICENSE](LICENSE).
