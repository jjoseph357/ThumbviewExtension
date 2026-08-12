<!-- # Drag-and-drop reordering — implementation steps -->

Companion to [DRAG_DROP_REORDER_PLAN.md](DRAG_DROP_REORDER_PLAN.md), which has the full
design rationale, message shapes, and line references. Written 2026-08-11 against
`main` @ v0.4.1; reorganized 2026-08-12 into two halves once the original step-by-step
numbering stopped matching reality (work landed out of order, follow-up bugs kept
getting appended under the step that triggered them, and it became hard to tell what
was actually still open).

- **Completed** — everything that's landed, kept as a record (not a numbered checklist)
  because most sections carry gotchas worth knowing if this code gets touched again.
- **Remaining Work** — a fresh, sequentially-numbered list of everything still open.
  Check boxes off here as they land.

---

## Completed

### Core reorder mechanics

- Ordering-bugfix sort; `PersistentFileOrder.swap()`/`.move()`.
- The `dragReorderMode` setting, its two commands, and `viewsWelcome` sidebar links;
  `getDragReorderMode()` and command registrations; `dragReorderMode` included in both
  `"data"` payloads.
- `"reorderFile"`/`"setDragReorderMode"` message handlers — fixed to call
  `if (activePanel) { updateLayoutFromCache(activePanel); }` after mutating `fileOrder`
  (originally missing, which silently no-op'd every drag: no tile moved, nothing
  persisted — until fixed).
- **Design change, not a defect:** the Actions modal has never had interactive controls,
  it's reference-only, so no `#drag-mode-swap`/`#drag-mode-shift` buttons were added.
  Instead the modal's "Setup & Settings" list got a one-line `Drag-to-Reorder` bullet
  explaining `swap`/`shift`, and mode-switching stays Command-Palette + sidebar-link
  only. Wiring modal buttons was dropped entirely — nothing to wire.
  `DRAG_DROP_REORDER_PLAN.md` has been updated to match this decision.

### Canvas drag state machine

Landed with several real bugs found and fixed along the way — worth knowing about
since they're easy to reintroduce if this code gets touched again:

- `draggingFile` must be the file object itself (`dragCandidate.file`), not the
  `{file, startX, startY}` candidate wrapper — everywhere downstream (`draggingFile.id`,
  `dragTargetFile === draggingFile`, the ghost/drop-target render code's
  `draggingFile._cell`) assumes it's a file.
- The hit-test + nearest-fallback scan is shared via one `findNearestFile(px, py)`
  helper (single merged loop — a direct hit returns immediately, no separate second
  pass over the array), called from both the live `mousemove` preview
  (`updateDragTarget()`) and the final `mouseup` resolution — not duplicated between
  them.
- The live cursor position the ghost/drop-target render code needs is `cursorPos`,
  module-level state assigned via `cursorPos = getCanvasPos(event)` with no `const` —
  shadowing it locally would silently break `render()`'s ability to see it.
- The "closest-to-last-tile → drop target becomes `null`" conversion (append-to-end) is
  applied only at `mouseup`, not inside `findNearestFile`/`updateDragTarget` itself —
  the live hover preview should keep pointing at the last tile so its outline doesn't
  vanish while hovering it; only the actual drop decision special-cases it.
- No close-button exclusion in `mousedown` (unlike `click`) — the movement threshold
  plus the `justDragged` guard on `click` already disambiguate a real close-click from a
  drag that happens to start near `×`.
- Folder cards stay excluded from drag candidacy — drag-to-reorder for folder cards
  (plus the pre-existing, unrelated quirk that folder-card order is sorted by file
  count, not `seenFiles` order) is tracked separately in
  [#35](https://github.com/jjoseph357/ThumbviewExtension/issues/35).

### Click-guard

`if (justDragged) { justDragged = false; return; }` guards the top of `click`, and
`mouseup` sets `justDragged = true` right before `clearDragState()`.

### Cancel paths

`mouseleave` and `Escape` both cancel via a shared `clearDragState()` helper (which
also properly `cancelAnimationFrame`s any pending `dragRafId` rather than just nulling
the id and leaving a stale frame queued); `contextmenu` cancels an in-progress drag
before falling through to the normal menu logic.

`dragGrabOffset` (captured in `mousedown`: `{ x: px - c.x, y: py - c.y }`) and the
genuinely-live module-level `cursorPos` are both in place — the two prerequisites the
render-polish work below needs.

**Bug found and fixed here:** cross-canvas drag wasn't suppressing the trailing click —
mousedown on a file, drag the cursor *outside* the canvas bounds before it crosses the
drag-promotion threshold, then move back onto the canvas and release over some file,
and that file's normal click behavior (jump-to-line/switchTab/close) would fire even
though the gesture was clearly a drag attempt. Root cause: `draggingFile` only ever
gets set via `mousemove` events firing *while the cursor is over the canvas* —
movement outside the canvas produces no `mousemove` at all, so a `candidateFile` that
hasn't yet been promoted just sat there. `mouseleave`'s cancel path used to only clear
state `if (draggingFile)`, not `candidateFile`, so it didn't help either way; by the
time the cursor re-entered and `mouseup` fired, `draggingFile` was still `null`, so the
merged click-resolution logic in `mouseup` (see the render-polish section below — the
`click` handler was later merged into `mouseup`) fell through to `candidateFile` and
fired its normal click action. Fixed by making `mouseleave` call `clearDragState()`
unconditionally instead of only `if (draggingFile)` — `clearDragState()` already nulls
`candidateFile`, so leaving the canvas now reliably clears a not-yet-promoted candidate
too, closing the gap.

### Render polish (ghost, dimming, drop-target outline)

**Touches:** `media/overview.js`, inside and just after `render()`'s per-tile
rendering. `render()`'s per-tile drawing was refactored (unrelated to this feature)
into a shared `drawFileTile(file, x, y, w, h, dimForFocus)` helper (`overview.js:1300`),
called from three separate, mutually-exclusive branches depending on layout mode:
subfolder-card mode's root-file loop, directory drill-down mode, and normal root-grid
mode. All three render-polish pieces below are drawn once, after that whole branch
chain (not inside any one branch), so nothing is skipped or duplicated depending on
which mode is active.

All three pieces are now built:

1. **Dimming the dragged tile in its original slot.** Landed for free as part of the
   `drawFileTile` refactor rather than as its own change: `drawFileTile` wraps its
   drawing in `ctx.globalAlpha = TILE_DIM_ALPHA` whenever `dimForFocus || file ===
   draggingFile` (`overview.js:1309-1310`), and `TILE_DIM_ALPHA` (`overview.js:1249`)
   is the same `0.15` constant used for subfolder-focus lowlighting. Applies
   automatically everywhere `drawFileTile` is called, no extra wiring needed.
2. **The ghost** — a stroked rect plus the dragged file's label, only
   `if (draggingFile)`, at `{ x: cursorPos.px - dragGrabOffset.x, y: cursorPos.py -
   dragGrabOffset.y }`, sized to `draggingFile._cell.w/h`.
3. **The drop-target outline** — stroked in the same spot, `dragTargetFile._cell`'s
   bounds, only `if (dragTargetFile)`, in the same `if (draggingFile) { … }` block as
   the ghost (so both share one accent color, `BORDER_STYLES.dragging`, intentionally).

No tweening/animation on the post-drop result — the grid just redraws once the updated
`"data"` message arrives, consistent with the rest of the codebase's snap convention.

**Bugs found and fixed while building pieces 2 and 3:**

- `dragPos` was used but never declared anywhere in the file (`ReferenceError` every
  frame while dragging) — the real live-position variable is `cursorPos`. Fixed.
- The drop-target outline read `dragTargetFile.x`/`.y` instead of
  `dragTargetFile._cell.x`/`._cell.y` — `RepoFile` has no top-level `x`/`y`, only
  `_cell` carries position; `strokeRect` silently no-ops on the resulting `NaN` args, so
  the outline never appeared even once other bugs were fixed. Fixed.
- The ghost's label text read `file._fittedLabel`, but `file` doesn't exist in this
  scope (outside all three per-tile loops, each of which scopes its own `const file` to
  the loop body) — another `ReferenceError`, one line *before* the drop-target outline
  code, so it aborted `render()` before ever reaching the outline (this is why fixing
  the `.x`/`.y` bug alone didn't make the outline appear). Fixed:
  `draggingFile._fittedLabel` + explicit `ctx.fillStyle`.
- The ghost's `ctx.font` was never set, so the label rendered in the canvas default
  font instead of `TILE_LABEL_FONT` (every `drawFileTile` call scopes its own
  `ctx.font = TILE_LABEL_FONT` inside a `save()`/`restore()` pair, so it never escapes
  the loop). Fixed: `ctx.font = TILE_LABEL_FONT;` added next to `ctx.fillStyle`.

**Still needs:** a final F5 visual pass — ghost follows the cursor smoothly, drop
target is clearly outlined and updates as you move over different tiles, dragged tile
is visibly dimmed in its original slot, no jank or flicker at 60fps. Not yet confirmed.

### General hover outline

New work that came out of Step 12 follow-up, not originally scoped in the plan: a
`BORDER_STYLES.dragging` (light blue) outline on whichever tile is under the cursor,
inset/thinner than the search-match/active/open borders so it doesn't fight with them —
deliberately the same color as the ghost and drop-target outline above.

- `findFileAt(px, py)` — exact hit-test only, no nearest-fallback, as distinct from
  `findNearestFile`'s drag-drop semantics.
- Module-level `hoveredFile`, resolved on every `mousemove` via
  `findFileAt(cursorPos.px, cursorPos.py)`.
- `updateHoverTooltip` (the pre-existing CTRL-hold magnify tooltip) now reads the
  global `hoveredFile` directly instead of re-scanning `filteredFiles` itself, and no
  longer takes `clientX`/`clientY` parameters — all three call sites invoke it bare.
- `cursorPos = null` removed from `clearDragState()` entirely — nothing depended on it
  being null there (every other read either freshly reassigns it earlier in the same
  handler, or is already gated behind `if (draggingFile)`, which `clearDragState()`
  also nulls), and three of the helper's four call sites (`Escape`, post-drop
  `mouseup`, `contextmenu` cancel) fire with the cursor still resting on a tile —
  nulling it there was misleading and had latent crash potential. `hoveredFile` and
  `cursorPos` are now only ever nulled together, explicitly, in the canvas `mouseleave`
  handler — the one place "the cursor position is genuinely unknown" is actually true.

**Bugs found and fixed along the way:**

- `findFileAt` referenced `filteredFiles` without declaring it (missing
  `const filteredFiles = getFilteredFiles();`). Fixed.
- `mousemove`'s hover resolution used the wrong property names —
  `findFileAt(cursorPos.x, cursorPos.y)` instead of `.px`/`.py` (`getCanvasPos`'s
  actual return shape) — so `hoveredFile` always resolved to `null`. Fixed.
- `updateHoverTooltip`'s tooltip-positioning code referenced `clientY` as if it were
  still a parameter, after the parameters were dropped (`ReferenceError`, fired every
  time the tooltip actually had content to show). Fixed: `lastMousePos.y` (screen-space,
  matching what `clientY` meant), not `cursorPos.py` (canvas-local, and used correctly
  elsewhere in the same function for tile-relative math).
- `sendOpenState` (`extension.ts:194`) and the `onDidChangeViewState` handler
  (`extension.ts:977`) both computed `activeFileUri` from
  `vscode.window.activeTextEditor` read live — which is only non-`undefined` when a
  real text editor has focus, never true while Thumbview itself has focus (which is
  always, since that's exactly when these two call sites fire) — so no tile ever
  showed the "active" border. Fixed by switching both to `lastActiveTextEditor`,
  already maintained by `onDidChangeActiveTextEditor` for this exact purpose but never
  wired up to either call site.
- `updateHoverTooltip` also had leftover dead code: `const { px, py } =
  getCanvasPos(event);` near the top of the function, unused (position comes from
  `cursorPos`/`lastMousePos` instead) and relying on the non-standard ambient
  `window.event` rather than any value actually passed in. Removed.

---

## Remaining Work

### 1. Docs

**Touches:** `CLAUDE.md`, `DRAG_DROP_REORDER_PLAN.md`.

- [x] Add `"reorderFile"`/`"setDragReorderMode"` to the `postMessage` protocol list in
  CLAUDE.md's "Cross-module interface" section.
- [x] Add a "Non-obvious things worth knowing" bullet describing the order-array-only,
  layout-agnostic design.
- [x] Add a bullet covering the new general hover outline (`findFileAt`, module-level
  `hoveredFile`, the shared blue `BORDER_STYLES.dragging` color across hover/ghost/
  drop-target).
- [x] Update `DRAG_DROP_REORDER_PLAN.md`'s status line to reflect the feature landing
  (kept, rather than deleted, for its implementation-narrative detail; status now
  points to this doc as the source of truth).
- [x] Add a `CHANGELOG.md` entry — added under a new `[Unreleased]` section rather than
  an existing version, since this hasn't been cut as a numbered release yet.
- [x] **Verify:** re-read CLAUDE.md's updated bullets cold — they explain the
  order-array/layout-agnostic design and the hover-outline color reuse without
  assuming prior context.

### 2. Full verification pass

Run all the scenarios from the plan doc's Verification section, now that everything is
built:

- [ ] Ghost follows the cursor smoothly, drop target is clearly outlined and updates
  as you move over different tiles, dragged tile is visibly dimmed in its original
  slot, general hover outline shows/hides correctly, no jank or flicker at 60fps.
- [ ] Swap mode (default): drag one tile onto another in `uniform_grid` — exactly
  those two trade positions, nothing else moves.
- [ ] Shift mode: drag a tile several positions away — everything between old/new
  position shifts by one, nothing outside that range moves.
- [ ] `spanning_grid` with two very-different-height files — result is reasonable;
  cascading repack after them in that column is expected, not a bug.
- [ ] Shrink the panel to trigger subfolder-card/drilldown mode, drag there, zoom back
  out — reorder is visible at the root level too.
- [ ] Small mousedown+mouseup with no movement still behaves as an ordinary click.
- [ ] `Escape` and dragging off-canvas both cancel with no order change.
- [ ] Order survives a rescan (edit+save a file) and a full reload.
- [ ] CTRL-hover magnify tooltip still works correctly (position, content,
  showing/hiding) after the `updateHoverTooltip` refactor.

### 3. Known bugs (not yet fixed)

> **Superseded 2026-08-12:** both bugs below, plus the two tabled feature requests in
> section 4, are rolled into a single unified fix in
> [DRAG_DROP_GRID_TARGETING_PLAN.md](DRAG_DROP_GRID_TARGETING_PLAN.md) — an internal
> grid-slot representation that resolves drops to a slot (occupied or empty) instead of
> "the nearest file." Kept here for the original bug trace/root-cause detail.

1. **Dragging onto or past the last file does nothing — confirmed root cause in swap
   mode.** `mouseup` converts a resolved target of "the last file" into
   `targetId: null` to mean "append to the end." In **swap mode**,
   `PersistentFileOrder.swap(idA, idB)` (`state.ts:49`) does
   `const j = this.seenFiles.indexOf(idB)`, and `indexOf(null)` is always `-1` — so the
   guard `if (i === -1 || j === -1 || i === j) return;` unconditionally no-ops. That
   means in swap mode, dropping on or past the last tile does *nothing at all* — and
   worse, since the null-conversion fires for a **direct hit on the actual last tile
   too**, not just "past" it, the last tile is currently completely un-swappable by
   drag, not just un-appendable-past. **Shift mode's `move(idToMove, null)`**
   (`state.ts:55`) looks correct on inspection — `to = idTarget === null ? -1 : ...`
   then `splice(to === -1 ? length : to, ...)` does append at the true end — so this
   may be a swap-mode-only bug; needs confirming in both modes once F5-tested. Fix
   direction to consider: swap mode has no meaningful interpretation of "append to end"
   at all (you can't swap with "nothing") — the null-conversion in `mouseup` probably
   shouldn't apply in swap mode, so dropping on/past the last tile in swap mode just
   swaps with the actual last tile instead of trying to mean something it can't
   express.

2. **Nearest-fallback in `findNearestFile` searches the whole grid, not scoped to the
   current column/row.** Since files are laid out in a single deliberate flow order
   (not scattered), a raw whole-grid Euclidean-nearest search can resolve to a tile in
   a visually-close but semantically-unrelated column, which reads as a random jump
   rather than "the tile nearest where I dropped in my intended direction." Worth
   scoping the fallback to only the current column (or row) before falling back
   further. **Design tension to resolve, not just an implementation detail:**
   `spanning_grid` is column-major (`buildSpanningGrid` walks `seenFileOrder` stacking
   down each column before starting a new one), but `uniform_grid` is **row-major**
   (`buildStableGrid` pushes `[c, r]` row-by-row) — so "current column" is the right
   scope for `spanning_grid` but "current row" would be the equivalent for
   `uniform_grid`. A single column-only rule would be wrong in `uniform_grid` mode.
   This also cuts against the plan's original layout-agnostic principle (operate
   purely on the order array, no grid-geometry-aware code) — scoping by column/row
   means the drag code would need to know which mode is active, which the rest of this
   feature deliberately avoided. Worth deciding deliberately rather than bolting on
   silently.

### 4. Tabled feature requests (not scheduled)

> **Superseded 2026-08-12:** see the note at the top of section 3 — both items below
> are folded into [DRAG_DROP_GRID_TARGETING_PLAN.md](DRAG_DROP_GRID_TARGETING_PLAN.md)
> along with the two known bugs. Kept here for the original architecture trace.

Two behavior changes the user asked for, explicitly tabled for a future pass. Recorded
here so they aren't lost, with enough of the current architecture traced out —
including a technical sketch worked out in a later conversation — that picking either
one up doesn't start from zero.

1. **Dragging a thumbnail into empty grid space.** Today there's no such thing as
   dropping "onto nothing" — `findNearestFile`/`updateDragTarget`/`mouseup` only ever
   resolve a drop to the *nearest existing file*, then swap/move against it. But empty
   cells do already exist in both layouts: `buildStableGrid` (`layout.ts:34-58`) grows
   the grid in whole row/column batches, so `slots.length` can overshoot `nCells` and
   leave trailing unused slots at the tail; `buildSpanningGrid`'s column-major packing
   (`spanning_layout.ts:96-123`) can likewise leave empty cells at the bottom of the
   last column when it doesn't divide evenly by `gridRows`. Those slots are currently
   just unaddressed blank canvas — no file has that slot index, and nothing hit-tests
   against it.

   **Technical approach worked out for this:** the host already sends enough
   (`layout.cols`/`rows` + each file's `.slot`/`.slots`/`.nCells`) to derive every
   slot's pixel rect — occupied or not — directly, since even a spanning file's
   placement is uniform base cells stacked vertically. So this doesn't need a
   Euclidean nearest-neighbor search like `findNearestFile`'s fallback — the target
   slot can be computed directly via `Math.floor((px - sideMargin) / cellW)` (and the
   row equivalent), then checked against a webview-side occupancy map
   (`"col,row" → file`, rebuilt from `data.files[*].slots` whenever data arrives). That
   needs: (a) `sideMargin`/`topMargin`/`cellW`/`cellH` lifted from `render()`-local
   consts to module-level state so drag-target resolution outside `render()` can reach
   them, and (b) a new `PersistentFileOrder` op for "place file at this specific array
   index" — `move()` currently only takes another file's id as the target
   (`state.ts:55-62`), not a raw slot/array position.

2. **Size-aware swap: dropping a smaller thumbnail onto a bigger one should slot the
   small file into the big file's place and leave the freed space below it empty,
   rather than cascading; only dropping a bigger thumbnail into a smaller slot should
   push other tiles around.** This only has meaning in `spanning_grid` (`uniform_grid`
   is all `nCells: 1`, so every tile is the same size and this distinction can't
   arise). It's a bigger change than it first sounds: `PersistentFileOrder.swap()`
   (`state.ts:49-53`) only swaps two ids' positions in the flat order array — it has no
   concept of cell span at all. The actual grid geometry is then rebuilt from scratch
   by `buildSpanningGrid`'s column-major walk (`spanning_layout.ts:100-123`), which
   packs files back-to-back with no gaps by design, but a reorder still triggers a
   full repack of the affected column. Getting "small-into-big leaves a gap,
   big-into-small cascades" would mean the order array alone can no longer fully
   describe the layout — either `buildSpanningGrid` needs to support genuine gaps
   (empty cells that aren't file-backed, tracked per-column), or the swap operation
   itself needs to become size-aware and produce a different mutation than a simple
   two-element array swap depending on which direction the size delta goes.

**Design tension carried over from Known bugs, item 2 above:** the original plan's
stated principle was that drag reorder logic stays layout-agnostic — it operates
purely on the order array, with zero awareness of grid geometry (`spanning_grid` vs
`uniform_grid`, column/row-major, cell spans). Both items above break that principle on
purpose. Worth deciding, when this is picked back up, whether that principle should be
dropped for this feature or whether both asks can be satisfied some other way that
preserves it — not something to bolt on silently.
