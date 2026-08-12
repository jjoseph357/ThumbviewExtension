# Drag-and-drop tile reordering (swap vs. shift, A/B testable)

> **Status:** Implemented — core swap/shift drag-to-reorder, render polish (ghost,
> dimming, drop-target outline), and a general hover outline all landed and merged to
> `main` 2026-08-12. Written 2026-08-07 on `woody-dev`; the design below is the
> original plan and may describe details that shifted during implementation (e.g. the
> separate canvas `click` listener described in section 4 was later merged into
> `mouseup` itself). For current status, known bugs, and remaining/tabled follow-up
> work, see `DRAG_DROP_IMPLEMENTATION_STEPS.md`. The durable architectural facts (the
> order-array-only design, the `postMessage` protocol additions) have been folded into
> CLAUDE.md's "Non-obvious things worth knowing" and "Cross-module interface"
> sections — this plan doc is kept around for its implementation-narrative detail but
> is no longer the source of truth for status.

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

**Zen mode (v0.4.0/v0.4.1, landed after this doc was first written):** Thumbview now
enters `workbench.action.toggleZenMode` (plus an editor-group maximize) on open/focus,
serialized through a promise queue, and masks the transition with `hideForTransition`/
`showAfterTransition` webview messages (see CLAUDE.md's "Fullscreen Mode via Zen Mode"
bullet). This doesn't change anything about the drag-reorder design — dragging only
happens once the webview is already visible and settled — but keep it in mind if a
future edit needs to post a message while a layout transition could be in flight.

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
  `updateLayoutFromCache` (`src/extension.ts:209-330`), the `spanning_grid` branch
  sends `files` already sorted in `seenFiles` order (because `buildSpanningGrid`'s
  `placements` are built by walking `seenFileOrder`), but the `uniform_grid` branch
  sends `files` in raw scan order (alphabetical) and only annotates `.slot` per file
  (`extension.ts:281-286`). The root grid render doesn't care (it draws by `.slot`),
  but the **subfolder-card and folder-drilldown views** (`media/overview.js`, e.g.
  `getSubfolderGroups`) lay out their own local grid by iterating the incoming `files`
  array order — so in `uniform_grid` mode today, those drilldown views would silently
  ignore any custom order. Fixing `uniform_grid`'s branch to sort `files` by
  `seenFiles` order (matching what `spanning_grid` already does) is required for drag
  reordering to be visibly consistent everywhere, in both modes — not just a nice-to-have.
- **Actions modal** (`#actions-modal` in `extension.ts:1640-1699`) is plain informational
  HTML/CSS and always has been — no interactive controls exist there for any setting,
  not just this one. **Decision (2026-08-11): keep it that way.** Mode-switching is
  exposed only via the Command Palette commands and the `thumbview-sidebar` welcome-view
  links (both from `package.json`); the modal just gets a one-line explanatory bullet
  in its existing "Setup & Settings" list, matching how `Layout` (`spanning_grid` /
  `uniform_grid`) is already documented there without a matching in-modal control.

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
  (`extension.ts:978-996`) — gives Command Palette access in addition to the modal toggle.
- The `thumbview-sidebar` view's `viewsWelcome.contents` string also hardcodes command
  links for the existing layout-mode pair ("Layout Settings" section) — add matching
  links for the two new commands there too, or they're Command-Palette-only.

### 3. `src/extension.ts`

- Add `getDragReorderMode()` helper mirroring `getLayoutMode()` (`extension.ts:126-130`).
- Register the two new commands (same shape as `setUniformGrid`/`setSpanningGrid`, now at
  `extension.ts:978-996`), each calling `config.update("dragReorderMode", ..., Global)`
  then refreshing the panel.
- **Ordering fix**: in the `uniform_grid` branch of `updateLayoutFromCache`
  (`extension.ts:281-286`), sort `filesWithSlots` by `order.indexOf(file.id)` before
  sending (matching `spanning_grid`'s existing seenFiles-order behavior), so drilldown/
  subfolder-card views reflect custom order consistently in both modes.
- Include `dragReorderMode: getDragReorderMode()` in both `"data"` postMessage payloads
  (currently unread on the webview side, since there's no modal toggle to sync — harmless
  to send, kept in case a future on-canvas indicator wants it).
- New `onDidReceiveMessage` cases:
  - `"reorderFile"` `{ sourceId, targetId }` → if `getDragReorderMode() === "swap"` call
    `fileOrder.swap(sourceId, targetId)`, else `fileOrder.move(sourceId, targetId)`; then
    `if (activePanel) { updateLayoutFromCache(activePanel); }` to relayout from the
    already-cached scan (no rescan needed) and push the updated `"data"` payload —
    `updateLayoutFromCache` already persists `fileOrder.getOrder()` to
    `workspaceState["thumbview.seenFiles"]` internally on every call, so no separate
    persist step is needed here (matches the existing `"ignoreFile"`/`"setDragReorderMode"`
    handlers' pattern). **Easy bug to introduce:** the swap/move mutates `fileOrder` in
    memory, but skipping the `updateLayoutFromCache` call means the webview never finds
    out — tiles won't visibly move and the reorder won't persist until something unrelated
    happens to trigger a refresh.
  - `"setDragReorderMode"` `{ mode }` → `config.update("dragReorderMode", mode, Global)`,
    then `updateLayoutFromCache(panel)`.
- Add a one-line **Drag-to-Reorder** bullet to the Actions modal's existing
  "Setup & Settings" `modal-section` (`extension.ts:1640-1699`), explaining `swap` vs
  `shift` — no interactive control, per the modal-stays-informational decision above.
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
  folder-card hits (folder cards are out of scope — see below) — sets `dragCandidate`
  only, no visual change yet. **No close-button exclusion**: unlike `click`, `mousedown`
  has the movement threshold + `justDragged` guard (below) to fall back on, so a plain
  close-click (no real movement) still resolves via `click`'s own `_closeBtn` check
  exactly as today, while a drag that happens to start near `×` is free to become a real
  drag instead of being blocked from candidacy.
- **`mousemove`** (extends existing listener): if `dragCandidate` and movement exceeds a
  small pixel threshold (~5px), promote it to `draggingFile` (drag officially starts).
  While `draggingFile` is set, rAF-throttle (reuse the existing hover-tooltip throttle
  pattern, `overview.js:1955-1968`) a re-hit-test for the current drop target and a
  `render()` call.
- **`mouseup`** (new listener): if `draggingFile`, resolve the drop target via the same
  `_cell` scan; if nothing hit, fall back to nearest-tile-center by Euclidean distance
  (handles empty margins/gaps generically — important for `spanning_grid`, which can
  leave gaps — without any grid-geometry-specific code). Post
  `{command: "reorderFile", sourceId: draggingFile.id, targetId: dragTargetFile?.id ?? null}`,
  set `justDragged = true`, clear drag state, `render()`.
- **Cancel paths**: `mouseleave` while dragging, and a new `Escape` keydown check
  (alongside the existing Ctrl-hold keydown/keyup handling, `overview.js:1710-1727`) both
  just clear drag state and `render()` without posting a message. The `contextmenu`
  handler cancels an in-progress drag first instead of opening the menu.
  **Known gap (found 2026-08-11, not yet fixed)**: `mouseleave` only clears state
  `if (draggingFile)` — a `dragCandidate` that left the canvas *before* crossing the
  promotion threshold survives untouched, movement outside the canvas produces no
  `mousemove` to ever promote it, and `mouseup` back inside then sees `draggingFile`
  still `null` and skips `justDragged`, so the trailing `click` fires unsuppressed on
  whatever's under the cursor at release — see `DRAG_DROP_IMPLEMENTATION_STEPS.md`'s
  Step 11 note for the full trace.
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
- **Scope exclusion**: only real file `_cell`s are draggable — folder cards
  (`data._folderCards`, subfolder-card mode) are not, since "move all of a folder's
  files as a block" is a different, harder feature. Dragging individual files *inside*
  a drilled-down folder view or a subfolder-card's expanded contents works normally
  through the same generic mechanism once the ordering fix in `extension.ts` lands.
  Folder-card reordering (plus the unrelated pre-existing quirk that folder-card order
  is sorted by file count, not `seenFiles` order) is tracked separately in
  [#35](https://github.com/jjoseph357/ThumbviewExtension/issues/35), out of scope here.

### Files touched

- `src/state.ts` — `swap`/`move` methods on `PersistentFileOrder`.
- `src/extension.ts` — config helper, 2 commands, ordering fix, 2 new message handlers,
  `dragReorderMode` field on `"data"`, one-line Actions-modal bullet, protocol comment update.
- `package.json` — new setting + 2 commands + `viewsWelcome` sidebar links.
- `media/overview.js` — mousedown/mouseup listeners, mousemove/click/contextmenu/keydown
  extensions, render additions.
- `CLAUDE.md` — postMessage protocol list, "Non-obvious things worth knowing" bullet
  describing the order-array-only, layout-agnostic design (per the project's own
  documentation-currency rule).

## Verification (manual — run `F5`, per project convention)

1. **Swap mode** (default): drag one tile onto another in `uniform_grid` — confirm
   exactly those two tiles trade positions and nothing else moves.
2. Toggle to **shift mode** via the Command Palette (`Thumbview: Use Shift Reorder Mode`)
   or the sidebar's "Shift Reorder" link, drag a tile several positions away — confirm
   every tile between old and new position shifts by one, nothing outside that range moves.
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
