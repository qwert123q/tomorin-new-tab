# Tomorin New Tab

English | [简体中文](README.zh-CN.md)

Tomorin New Tab is a lightweight, local-first Chrome new tab extension inspired by Infinity New Tab.

## Features

- Replaces Chrome's new tab page.
- Uses Chrome's default search engine through the `chrome.search` API.
- Opens typed URLs directly.
- Shows paginated favorite website shortcuts.
- Starts with a small generic shortcut set.
- Adds, edits, deletes, resizes, and reorders shortcuts from the page.
- Opens shortcut editing directly from a right-click.
- Switches global icon density between small, medium, and large.
- Keeps controls tucked behind a hover/focus gear menu.
- Imports website shortcuts from an Infinity New Tab backup JSON.
- Uses a high-resolution favicon fallback chain to show website icons automatically.
- Shows selectable icon candidates while editing a shortcut.
- Supports per-shortcut custom icon uploads for sites that cannot be resolved automatically.
- Reads icons and brand images declared by the website page or manifest, so the edit dialog can offer sharper candidates.
- Caches saved shortcut icons into local IndexedDB and renders from the local copy after that.
- Automatically caches whichever shortcut icon successfully renders, so repeated new tabs reuse the local icon.
- Keeps uploaded wallpapers sharp by avoiding display blur and preserving near-4K resolution.
- Stores shortcut data locally with `chrome.storage.local`.
- Stores uploaded wallpaper images locally in IndexedDB.
- Does not use an account, server, cloud sync, or wallpaper API.

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

## Local Data

Shortcut metadata is saved in Chrome extension local storage. Uploaded wallpaper image data and saved shortcut icons are saved in the extension's IndexedDB database. Both are local to the current Chrome profile and are removed when the extension is removed.

See [PRIVACY.md](PRIVACY.md) for details.

## License

MIT. See [LICENSE](LICENSE).
