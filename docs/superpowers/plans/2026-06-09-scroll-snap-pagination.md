# Scroll Snap Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle temporary page-transition layer with native horizontal scrolling and CSS scroll snap.

**Architecture:** Render all shortcut pages inside a horizontally scrollable viewport. Use scroll position as the source of active page truth for gestures, while keeping existing shortcut data, icon cache, sync, edit dialogs, and drag/drop logic.

**Tech Stack:** Chrome extension Manifest V3, native DOM APIs, CSS scroll snap, Playwright verification scripts.

---

### Task 1: Add Failing Scroll Snap Tests

**Files:**
- Modify: `scripts/verify-drag-slot-reorder.cjs`
- Modify: `scripts/verify-compact-layout.cjs`

- [x] Assert that the shortcut UI contains `.shortcut-viewport` and `.shortcut-pages`.
- [x] Assert multiple `.shortcut-page` nodes are rendered at once for multi-page data.
- [x] Assert `.shortcut-transition` is absent.
- [x] Assert horizontal wheel/touch gestures update `.page-dot.active`.
- [x] Assert drag/drop queries are scoped to the current page.

Run:

```bash
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-drag-slot-reorder.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-compact-layout.cjs
```

Expected before implementation: fail because the current DOM only has one rendered page and uses `.shortcut-transition`.

### Task 2: Replace Pagination DOM

**Files:**
- Modify: `extension/index.html`
- Modify: `extension/app.js`
- Modify: `extension/style.css`

- [x] Replace the single `#shortcutPage` div with `#shortcutViewport > #shortcutPages`.
- [x] Render all pages in `renderShortcuts()`.
- [x] Make `.shortcut-viewport` horizontally scrollable.
- [x] Make `.shortcut-page` snap-aligned horizontal pages.
- [x] Remove `.shortcut-transition` and `.shortcut-slide`.

### Task 3: Rewire Page State

**Files:**
- Modify: `extension/app.js`

- [x] Add a debounced scroll handler that derives current page from `scrollLeft / viewportWidth`.
- [x] Make page dots and arrow keys call smooth native scrolling.
- [x] Keep save behavior for `currentPage`, but do not re-render pages on every scroll tick.
- [x] Keep edit mode and density changes positioned on the active page after re-render.

### Task 4: Preserve Editing and Drag/Drop

**Files:**
- Modify: `extension/app.js`
- Modify: `extension/style.css`
- Modify: `scripts/verify-edit-mode-flow.cjs`
- Modify: `scripts/verify-drag-slot-reorder.cjs`

- [x] Keep right-click entering global edit mode.
- [x] Keep click-in-edit-mode opening the selected shortcut editor.
- [x] Keep add tile aligned with shortcut icons.
- [x] Scope slot and card queries to the active page where needed.
- [x] Keep drag/drop within the active page.

### Task 5: Verify and Package

Run:

```bash
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check extension/app.js
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-drag-slot-reorder.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-edit-mode-flow.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-compact-layout.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-hover-affordances.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-icon-handling.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-local-icon-cache.cjs
NODE_PATH=/Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules /Users/tomorin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/verify-sync.cjs
./scripts/package-extension.sh
```

Expected: all commands exit 0 and package `0.1.36` is generated.
