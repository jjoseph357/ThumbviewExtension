# Drag-and-drop tile reordering (swap vs. shift, A/B testable)

> **Status:** Planning only — not yet implemented. Written 2026-08-07 on `woody-dev`.
> Update or delete this doc once the feature lands (fold the durable parts into
> CLAUDE.md/DESIGN.md per this repo's documentation-currency rule).

## Context

Thumbview currently has no way to manually reorder tiles — grid position is entirely
derived from `PersistentFileOrder` (`src/state.ts`), which only changes in response to
files appearing/disappearing during a rescan. The goal is to click-drag a file tile
onto another tile's position and have the grid reorder, with two different results of
a drop to compare side by side:

- **Swap** — the dragged tile and the tile occupying the drop target trade places;
  nothing else moves.
- **Shift** — the dragged tile is inserted at the drop target's position; every tile
  between the tile's old and new position shifts over by one to make room (array-move
  semantics).

Both behaviors must work in `uniform_grid` and `spanning_grid` alike, and ought to
generalize to any future layout mode without new geometry-aware code — so the whole
feature is designed to operate purely on the **order array** (`PersistentFileOrder`),
never on grid coordinates. Grid coordinates (`buildStableGrid`/`buildSpanningGrid`) are
already a pure function of that order array and file count/height, so reordering the
array and letting the existing layout builders recompute is sufficient in every mode,
present or future.

## Key existing mechanics this plan builds on

- **`PersistentFileOrder`** (`src/state.ts`) holds `seenFiles: string[]`, a file-id
  array. Grid position is derived from it: `buildStableGrid` (uniform) looks up
  `order.indexOf(file.id)`; `buildSpanningGrid` (spanning) walks `seenFileOrder`
  directly to pack tiles column-major. **Reordering `seenFiles` is the single lever
  that moves tiles in every layout mode.**
- **`RepoFile.id`** (`src/scanner.ts:16`) is `file.fsPath` — a stable id already used
  as the reorder key everywhere, perfect for `sourceId`/`targetId` in the new message.
- **Rendering is canvas-only** (`media/overview.js`) — every tile's on-screen box is
  `file._cell` (`{x, y, w, h}`), recomputed fresh on every `render()`. All existing
  interactions (click, auxclick, contextmenu, hover) hit-test the same way: linear scan
  over `getFilteredFiles()` checking `_cell` bounds. There is **no drag/drop code
  today** and **no tile-position animation** anywhere in the codebase — reorders
  currently just snap because `render()` is a full redraw.
- **Pre-existing ordering inconsistency to fix as a prerequisite**: in
  `updateLayoutFromCache` (`src/extension.ts:207-328`), the `spanning_grid` branch
  sends `files` already sorted in `seenFiles` order (because `buildSpanningGrid`'s
  `placements` are built by walking `seenFileOrder`), but the `uniform_grid` branch
  sends `files` in raw scan order (alphabetical) and only annotates `.slot` per file
  (`extension.ts:279-284`). The root grid render doesn't care (it draws by `.slot`),
  but the **subfolder-card and folder-drilldown views** (`media/overview.js`, e.g.
  `getSubfolderGroups`) lay out their own local grid by iterating the incoming `files`
  array order — so in `uniform_grid` mode today, those drilldown views would silently
  ignore any custom order. Fixing `uniform_grid`'s branch to sort `files` by
  `seenFiles` order (matching what `spanning_grid` already does) is required for drag
  reordering to be visibly consistent everywhere, in both modes — not just a nice-to-have.
- **Actions modal** (`#actions-modal` in `extension.ts:1481-1540`) is plain informational
  HTML/CSS today (no interactive controls). The search bar's `.search-option-btn` /
  `.active` toggle pattern (`overview.js:106-149`) is the closest existing precedent for
  a clickable toggle, but those are webview-local state; our toggle must be readable by
  the **host** (since the reorder methods run in `extension.ts`), so it's backed by a
  real VS Code setting, not local JS state.

## Design

### 1. `src/state.ts` — two new `PersistentFileOrder` methods (pure array ops, layout-agnostic)

```ts
swap(idA: string, idB: string) {
    const i = this.seenFiles.indexOf(idA), j = this.seenFiles.indexOf(idB);
    if (i === -1 || j === -1 || i === j) return;
    [this.seenFiles[i], this.seenFiles[j]] = [this.seenFiles[j], this.seenFiles[i]];
}

move(idToMove: string, idTarget: string | null) {
    const from = this.seenFiles.indexOf(idToMove);
    if (from === -1 || idToMove === idTarget) return;
    this.seenFiles.splice(from, 1);
    const to = idTarget === null ? -1 : this.seenFiles.indexOf(idTarget);
    this.seenFiles.splice(to === -1 ? this.seenFiles.length : to, 0, idToMove);
}
```
`targetId: null` means "drop past the last tile" → move to the end.

### 2. `package.json` — new setting + commands

- `thumbview.dragReorderMode`: enum `["swap", "shift"]`, default `"swap"`, alongside the
  existing `thumbview.layoutMode` setting.
- Commands `thumbview.setSwapReorderMode` / `thumbview.setShiftReorderMode`, mirroring
  the existing `thumbview.setUniformGrid` / `thumbview.setSpanningGrid` pair
  (`extension.ts:819-837`) — gives Command Palette access in addition to the modal toggle.

### 3. `src/extension.ts`

- Add `getDragReorderMode()` helper mirroring `getLayoutMode()` (`extension.ts:124-128`).
- Register the two new commands (same shape as `setUniformGrid`/`setSpanningGrid`), each
  calling `config.update("dragReorderMode", ..., Global)` then refreshing the panel.
- **Ordering fix**: in the `uniform_grid` branch of `updateLayoutFromCache`
  (`extension.ts:276-284`), sort `filesWithSlots` by `order.indexOf(file.id)` before
  sending (matching `spanning_grid`'s existing seenFiles-order behavior), so drilldown/
  subfolder-card views reflect custom order consistently in both modes.
- Include `dragReorderMode: getDragReorderMode()` in both `"data"` postMessage payloads,
  so the webview can render the Actions-modal toggle's true persisted state.
- New `onDidReceiveMessage` cases:
  - `"reorderFile"` `{ sourceId, targetId }` → if `getDragReorderMode() === "swap"` call
    `fileOrder.swap(sourceId, targetId)`, else `fileOrder.move(sourceId, targetId)`;
    persist `context.workspaceState.update("thumbview.seenFiles", fileOrder.getOrder())`;
    call `updateLayoutFromCache(panel)` to relayout from the already-cached scan (no
    rescan needed) and push the updated `"data"` payload.
  - `"setDragReorderMode"` `{ mode }` → `config.update("dragReorderMode", mode, Global)`,
    then `updateLayoutFromCache(panel)` so the modal's toggle state updates immediately.
- Add a **"Drag & Drop Reordering"** section to the Actions modal HTML
  (`extension.ts:1481-1540`, alongside the other `modal-section` blocks): a two-button
  segmented control (`#drag-mode-swap`, `#drag-mode-shift`), styled like
  `.search-option-btn`, with a one-line explanation of each mode for the user testing them.
- Update the `postMessage` protocol comment/list in both `extension.ts` and CLAUDE.md
  per the project's own documentation-currency rule (new commands: `"reorderFile"`,
  `"setDragReorderMode"`; new `"data"` field: `dragReorderMode`).

### 4. `media/overview.js` — drag interaction (canvas-only, no native HTML5 DnD)

Since tiles are canvas-drawn (no per-tile DOM elements), dragging is implemented as a
manual mousedown → threshold → mousemove → mouseup state machine, reusing the existing
`_cell` AABB hit-test pattern already used by click/auxclick/contextmenu/hover:

- **New state**: `dragCandidate` (file + start x/y, set on mousedown, not yet a drag),
  `draggingFile`, `dragGrabOffset` (cursor offset within the tile, for a natural-feeling
  ghost), `dragPos`, `dragTargetFile`, `justDragged` (guards the click handler after drop).
- **`mousedown`** (new listener on `canvas`): same `_cell` scan as `click`, **excluding**
  the close-button (`×`) hitbox and folder-card hits (folder cards are out of scope —
  see below) — sets `dragCandidate` only, no visual change yet.
- **`mousemove`** (extends existing listener): if `dragCandidate` and movement exceeds a
  small pixel threshold (~5px), promote it to `draggingFile` (drag officially starts).
  While `draggingFile` is set, rAF-throttle (reuse the existing hover-tooltip throttle
  pattern, `overview.js:1953-1958`) a re-hit-test for the current drop target and a
  `render()` call.
- **`mouseup`** (new listener): if `draggingFile`, resolve the drop target via the same
  `_cell` scan; if nothing hit, fall back to nearest-tile-center by Euclidean distance
  (handles empty margins/gaps generically — important for `spanning_grid`, which can
  leave gaps — without any grid-geometry-specific code). Post
  `{command: "reorderFile", sourceId: draggingFile.id, targetId: dragTargetFile?.id ?? null}`,
  set `justDragged = true`, clear drag state, `render()`.
- **Cancel paths**: `mouseleave` while dragging, and a new `Escape` keydown check
  (alongside the existing Ctrl-hold keydown/keyup handling, `overview.js:1700-1722`) both
  just clear drag state and `render()` without posting a message. The `contextmenu`
  handler cancels an in-progress drag first instead of opening the menu.
- **Guard existing `click` handler**: add `if (justDragged) { justDragged = false; return; }`
  at the top, so the click that naturally follows a drag-drop's mouseup doesn't also
  trigger jump/switchTab/close. Below-threshold mousedown+mouseup (a normal click) never
  sets `justDragged`, so ordinary clicks are untouched.
- **Render additions** (inside the existing `render()` per-tile loop): draw the dragged
  tile at reduced alpha (reusing the existing `ctx.globalAlpha` dimming convention used
  for folder-focus lowlighting) in its original slot; draw a lightweight ghost (border +
  filename label, not a full re-tokenized minimap — cheap per-frame) following the cursor
  at `dragPos - dragGrabOffset`; stroke the current drop-target tile's `_cell` in an
  accent color. No tweening/animation of the post-drop result — consistent with the
  codebase's existing snap-to-new-position convention, the grid just redraws once the
  updated `"data"` message arrives.
- **`"data"` handler**: store `data.dragReorderMode` and sync the Actions-modal toggle
  buttons' active state from it.
- **New click handlers** for `#drag-mode-swap` / `#drag-mode-shift` → post
  `{command: "setDragReorderMode", mode}`.
- **Scope exclusion**: only real file `_cell`s are draggable — folder cards
  (`data._folderCards`, subfolder-card mode) are not, since "move all of a folder's
  files as a block" is a different, harder feature. Dragging individual files *inside*
  a drilled-down folder view or a subfolder-card's expanded contents works normally
  through the same generic mechanism once the ordering fix in `extension.ts` lands.

### Files touched

- `src/state.ts` — `swap`/`move` methods on `PersistentFileOrder`.
- `src/extension.ts` — config helper, 2 commands, ordering fix, 2 new message handlers,
  `dragReorderMode` field on `"data"`, Actions-modal HTML section, protocol comment update.
- `package.json` — new setting + 2 commands.
- `media/overview.js` — mousedown/mouseup listeners, mousemove/click/contextmenu/keydown
  extensions, render additions, modal toggle wiring.
- `CLAUDE.md` — postMessage protocol list, "Non-obvious things worth knowing" bullet
  describing the order-array-only, layout-agnostic design (per the project's own
  documentation-currency rule).

## Verification (manual — run `F5`, per project convention)

1. **Swap mode** (default): drag one tile onto another in `uniform_grid` — confirm
   exactly those two tiles trade positions and nothing else moves.
2. Toggle to **shift mode** via the new Actions-modal control (or Command Palette),
   drag a tile several positions away — confirm every tile between old and new position
   shifts by one, nothing outside that range moves.
3. Repeat both in `spanning_grid` with two files of very different line counts — confirm
   the result is reasonable; note that swapping tiles of different heights there can
   cascade-repack everything after them in that column, which is inherent to
   `buildSpanningGrid`'s existing sequential packing, not a bug in this feature.
4. Shrink the panel (or focus a large folder) to trigger subfolder-card /
   folder-drilldown mode, drag a tile there, then zoom back out to the root grid and
   confirm the reorder persisted and is visible at the root level too.
5. Confirm a small mousedown+mouseup with no real movement still behaves as an ordinary
   click (jump-to-line / close / focus-folder, whichever zone).
6. Confirm `Escape` and dragging the mouse off the canvas both cancel cleanly with no
   order change.
7. Confirm order survives a rescan (edit+save a file) and a full reload (persisted via
   `workspaceState["thumbview.seenFiles"]`, same mechanism `update()`/`reflow()` already use).
