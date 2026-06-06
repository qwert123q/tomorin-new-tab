# Tomorin New Tab

A lightweight Chrome new tab extension inspired by Infinity New Tab.

## Features

- Replaces Chrome's new tab page.
- Uses Chrome's default search engine through the `chrome.search` API.
- Opens typed URLs directly.
- Shows paginated favorite website shortcuts.
- Starts with a small generic shortcut set.
- Adds, edits, deletes, resizes, and reorders shortcuts from the page.
- Switches global icon density between 小 / 中 / 大.
- Imports website shortcuts from an Infinity New Tab backup JSON.
- Uses Chrome's favicon API to show website icons automatically.
- Stores shortcut data locally with `chrome.storage.local`.
- Stores uploaded wallpaper images locally in IndexedDB.
- Does not use an account, server, cloud sync, or wallpaper API.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/` folder.
5. Open a new tab.

## Local Data

Shortcut metadata is saved in Chrome extension local storage. Uploaded wallpaper image data is saved in the extension's IndexedDB database. Both are local to the current Chrome profile and are removed when the extension is removed.
