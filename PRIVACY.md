# Privacy Policy

Tomorin New Tab is designed as a local-first Chrome new tab extension.

## Data Stored Locally

The extension stores the following data in the current Chrome profile:

- Shortcut titles, URLs, order, and icon settings in `chrome.storage.local`.
- Uploaded wallpaper images in the extension's IndexedDB database.
- Saved shortcut icon images in the extension's IndexedDB database.
- Local UI settings such as icon density and current page.

This data stays on the user's device and is removed when the extension is removed from Chrome.

## Network Requests

The extension may make network requests for icon discovery and caching:

- When a shortcut has no cached icon, the extension may fetch favicon candidates and cache the first working icon locally.
- When the user adds or edits a shortcut, the extension may fetch that website's page or manifest to discover declared icons and brand images.
- The extension may request favicon candidates from browser or public favicon endpoints such as Google favicon service or DuckDuckGo favicon service.

These requests are used only to display or cache shortcut icons.

## What This Extension Does Not Do

- It does not require an account.
- It does not run a remote backend controlled by this project.
- It does not upload shortcut data, wallpaper images, or saved icon images to a project server.
- It does not sell, share, or broker user data.
- It does not use analytics, tracking pixels, advertising SDKs, or telemetry.

## Permissions

The extension uses:

- `storage`: saves shortcut metadata and settings locally.
- `favicon`: reads Chrome favicon data when available.
- `search`: sends searches to the user's configured Chrome search provider.
- `<all_urls>` host permission: allows icon discovery from websites that users choose to add or edit.

## Contact

For questions or issues, open an issue in the GitHub repository.
