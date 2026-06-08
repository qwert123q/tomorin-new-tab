# Scroll Snap Pagination Design

## Problem

The current shortcut pagination is brittle. It renders one page at a time, then tries to fake a horizontal page transition with a temporary `.shortcut-transition` layer. In practice this can still feel like the old page disappears and the next page appears immediately. The model also makes edit mode, drag/drop slots, page dots, and fast gestures harder to reason about.

The desired behavior is closer to a phone home screen: while moving horizontally, the outgoing page and incoming page should both be visible as part of the same continuous surface.

## Direction

Replace the one-page-plus-temporary-layer model with a native horizontal scroll model:

- Render every shortcut page as a sibling inside one horizontal viewport.
- Use CSS scroll snapping for page boundaries.
- Use the browser's native horizontal scroll/trackpad behavior for gradual movement.
- Use `scrollTo({ behavior: 'smooth' })` only for page dots and keyboard navigation.
- Derive `currentPage` from `scrollLeft / pageWidth` instead of swapping DOM before the transition.

This changes the pagination rendering model, not the data model.

## Architecture

The shortcut area will become:

```html
<div class="shortcut-viewport">
  <div class="shortcut-pages">
    <section class="shortcut-page" data-page="0">...</section>
    <section class="shortcut-page" data-page="1">...</section>
  </div>
</div>
```

Each `.shortcut-page` keeps the existing 4x8 grid. Existing `.shortcut-card`, `.shortcut-slot`, `.add-shortcut-tile`, density classes, edit markers, and local icon behavior remain conceptually unchanged.

## Rendering Rules

- `renderShortcuts()` renders all pages, not only the current page.
- Normal mode renders only actual shortcuts per page.
- Edit mode renders 32 slots per page and places the add tile immediately after the final shortcut.
- The last edit-mode page may contain empty slots after the add tile.
- Page dots are based on the page count and update as scrolling settles.

## Interaction Rules

- Trackpad or mouse horizontal scrolling should move the pages naturally.
- Page dots and arrow keys call a helper that scrolls to the target page.
- The active page is updated after scroll movement using a lightweight debounced scroll handler.
- Clicking blank areas in edit mode still exits edit mode.
- Clicking a shortcut in edit mode still opens that shortcut editor.
- Right-clicking a shortcut still enters global edit mode without opening a specific editor.
- Drag/drop remains scoped to the currently visible page for this version.

## Out of Scope

- No React, Vue, or large UI framework.
- No canvas renderer.
- No cross-page drag/drop in this pass.
- No physics engine or custom inertial scrolling.
- No changes to sync payloads, IndexedDB icon cache, wallpaper storage, or shortcut schema.

## Testing

Update existing Playwright scripts to verify:

- Multiple pages are rendered inside one scroll viewport.
- Horizontal scrolling changes the active page without temporary transition layers.
- Page dots and keyboard navigation scroll to the target page.
- Edit mode still renders 32 slots on the visible page.
- The add tile aligns with shortcut icons.
- Drag/drop still reorders within the current page.
- Existing icon cache, sync, layout, and hover affordance tests continue to pass.

## Success Criteria

- Slow horizontal movement visibly reveals the next page while the previous page leaves.
- There is no `.shortcut-transition` temporary animation layer.
- The extension stays local-first and lightweight.
- Existing user data remains compatible.
