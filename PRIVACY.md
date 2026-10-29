# Privacy Policy

Tomorin New Tab is designed as a local-first Chrome new tab extension.

Optional self-hosted sync is disabled by default. When the user enables it, the extension exchanges the data listed below with the server URL configured by the user, and with no other server.

## Data Stored Locally

The extension stores the following data in the current Chrome profile:

- Shortcut titles, URLs, size, order, icon choices and deletion records in `chrome.storage.local`.
- Local settings such as icon density, search engine, current page and sync settings (server URL and sync password).
- A backup of the local shortcut list, kept before sync replaces or removes several shortcuts.
- Uploaded wallpaper images, cached shortcut icon images and uploaded icon images in the extension's IndexedDB database.

This data stays on the user's device and is removed when the extension is removed from Chrome.

## Network Requests

The extension may make network requests to find and cache shortcut icons:

- It may fetch a shortcut website's page, web app manifest and declared icon files, and the same for the site's mobile version (`m.` address) when only small icons are found.
- It may request icons from browser or public favicon endpoints such as the Google favicon service or the DuckDuckGo favicon service.

These requests are used only to display or cache shortcut icons. They are made without cookies.

If optional self-hosted sync is enabled, the extension also sends to and receives from the user's server:

- Shortcut titles, URLs, size, order, icon choices and deletion records.
- The icon density setting.
- The wallpaper image and icon images the user uploaded.

The search engine choice, current page and cached icon images found automatically are not synced.

## What This Extension Does Not Do

- It does not require an account.
- It does not run a remote backend controlled by this project.
- It does not upload any data to a project-controlled server.
- It does not sell, share, or broker user data.
- It does not use analytics, tracking pixels, advertising SDKs, or telemetry.

## Permissions

The extension uses:

- `storage`: saves shortcut data and settings locally.
- `favicon`: reads Chrome favicon data when available.
- `search`: sends searches to the user's configured Chrome search provider.
- `<all_urls>` host permission: allows icon discovery from websites that users add, and connecting to the user's own sync server.

## Contact

For questions or issues, open an issue in the GitHub repository.
