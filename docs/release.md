# Release Guide

## Local Package

Run:

```bash
./scripts/package-extension.sh
```

This creates `dist/tomorin-new-tab-<version>.zip`. The zip contains the files in `extension/` with `manifest.json` at the package root, which is the format Chrome expects.

## Manual Installation

1. Unzip the package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped extension folder.

## Chrome Web Store Checklist

- Confirm `extension/manifest.json` has the correct version.
- Run the verification scripts before packaging.
- Package the extension with `./scripts/package-extension.sh`.
- Prepare store listing screenshots and promotional images.
- Provide a privacy policy URL, for example the published `PRIVACY.md` page.
- Explain the `<all_urls>` permission in the listing: it is used to discover website icons for shortcuts chosen by the user.
- Upload the zip in the Chrome Web Store Developer Dashboard and submit it for review.

Official references:

- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Chrome Web Store Program Policies](https://developer.chrome.google.cn/docs/webstore/program-policies/policies)

## Verification Commands

```bash
node --check extension/app.js
for file in scripts/*.cjs; do node --check "$file"; done
python3 -m json.tool extension/manifest.json >/dev/null
git diff --check
```

The browser-based verification scripts require Playwright and Chrome. If Playwright is available on `NODE_PATH`, run:

```bash
node scripts/verify-icon-handling.cjs
node scripts/verify-compact-layout.cjs
node scripts/verify-density.cjs
node scripts/verify-auto-icon-cache.cjs
node scripts/verify-local-icon-cache.cjs
node scripts/verify-infinity-import.cjs
node scripts/verify-wallpaper-quality.cjs
```
