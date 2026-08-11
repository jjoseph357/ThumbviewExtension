<!-- # Drag-and-drop reordering — implementation steps -->

Companion to [DRAG_DROP_REORDER_PLAN.md](DRAG_DROP_REORDER_PLAN.md), which has the full
design rationale, message shapes, and line references. This doc just sequences the same
work into small, independently-verifiable steps, ordered so you're never debugging two
new layers at once — each step has something concrete to check before moving to the next.
Written 2026-08-11 against `main` @ v0.4.1.

Check boxes off as you land them. If a step's behavior doesn't match its "Verify" line,
stop there — don't stack the next step on top of a broken one.

**Steps 1-11 are done and verified** (2026-08-11).

**Steps 1-5, 7:** ordering-bugfix sort, `PersistentFileOrder.swap()`/`.move()`, the
`dragReorderMode` setting + two commands + `viewsWelcome` sidebar links,
`getDragReorderMode()` + command registrations, and `dragReorderMode` in both `"data"`
payloads.

**Design change, not a defect:** Step 7 was rescoped mid-implementation — you correctly
pointed out the Actions modal has never had interactive controls, it's reference-only,
so no `#drag-mode-swap`/`#drag-mode-shift` buttons were added. Instead the modal's
"Setup & Settings" list got a one-line `Drag-to-Reorder` bullet explaining `swap`/`shift`,
and mode-switching stays Command-Palette + sidebar-link only (already covered by Steps
3-4). **Step 8 (wire the modal buttons) is dropped entirely** — nothing to wire.
`DRAG_DROP_REORDER_PLAN.md` has been updated to match this decision.

**Step 6:** `"reorderFile"`/`"setDragReorderMode"` handlers, fixed to call
`if (activePanel) { updateLayoutFromCache(activePanel); }` after mutating `fileOrder`
(originally missing, which silently no-op'd every drag — no tile moved, nothing
persisted — until fixed).

---

### Step 9 — Canvas drag state machine

Landed with several real bugs found and fixed along the way — worth knowing about
since they're easy to reintroduce if this code gets touched again:

- `draggingFile` must be the file object itself (`dragCandidate.file`), not the
  `{file, startX, startY}` candidate wrapper — everywhere downstream (`draggingFile.id`,
  `dragTargetFile === draggingFile`, Step 12's `draggingFile._cell`) assumes it's a file.
- The hit-test + nearest-fallback scan is shared via one `findNearestFile(px, py)`
  helper (single merged loop — a direct hit returns immediately, no separate second
  pass over the array), called from both the live `mousemove` preview
  (`updateDragTarget()`) and the final `mouseup` resolution — not duplicated between them.
- `dragPos` is module-level state, assigned via `dragPos = getCanvasPos(event)` with no
  `const` — shadowing it locally would silently break `render()`'s ability to see the
  live cursor position for Step 12's ghost.
- The "closest-to-last-tile → drop target becomes `null`" conversion (append-to-end) is
  applied only at `mouseup`, not inside `findNearestFile`/`updateDragTarget` itself — the
  live hover preview should keep pointing at the last tile so its outline doesn't vanish
  while hovering it; only the actual drop decision special-cases it.
- No close-button exclusion in `mousedown` (unlike `click`) — the movement threshold plus
  the `justDragged` guard on `click` already disambiguate a real close-click from a drag
  that happens to start near `×`.
- Folder cards stay excluded from drag candidacy — drag-to-reorder for folder cards
  (plus the pre-existing, unrelated quirk that folder-card order is sorted by file count,
  not `seenFiles` order) is tracked separately in
  [#35](https://github.com/jjoseph357/ThumbviewExtension/issues/35).

---

### Step 10 — `click`-guard, done

`if (justDragged) { justDragged = false; return; }` guards the top of `click`, and
`mouseup` sets `justDragged = true` right before `clearDragState()`.

---

### Step 11 — Cancel paths, done

`mouseleave` and `Escape` both cancel via a shared `clearDragState()` helper (which
also properly `cancelAnimationFrame`s any pending `dragRafId` rather than just nulling
the id and leaving a stale frame queued); `contextmenu` cancels an in-progress drag
before falling through to the normal menu logic.

`dragGrabOffset` (captured in `mousedown`: `{ x: px - c.x, y: py - c.y }`) and the
genuinely-live module-level `dragPos` from Step 9 are both in place — the two
prerequisites Step 12 needs.

**Known issue, not yet fixed (found 2026-08-11):** mousedown on a file, drag the cursor
*outside* the canvas bounds before it crosses the drag-promotion threshold, then move
back onto the canvas and release over some file — that file's normal click behavior
(jump-to-line/switchTab/close) fires, even though the gesture was clearly a drag attempt.
Root cause: `draggingFile` only ever gets set via `mousemove` events firing *while the
cursor is over the canvas* — movement outside the canvas produces no `mousemove` at all,
so a `dragCandidate` that hasn't yet been promoted just sits there. `mouseleave`'s cancel
path only clears state `if (draggingFile)`, not `dragCandidate`, so it doesn't help
either way. By the time the cursor re-enters and `mouseup` fires, `draggingFile` is still
`null`, so `mouseup`'s `if (!draggingFile) { dragCandidate = null; return; }` guard
decides this was never a drag and returns without setting `justDragged` — so the
trailing `click` isn't suppressed and fires normally on whatever's under the cursor at
release. Simply clearing `dragCandidate` on `mouseleave` doesn't fix the actual symptom
(the trailing click still fires unsuppressed) — a real fix likely needs `mouseleave` (or
`mousedown` itself) to treat "cursor left the canvas while a candidate/drag was active"
as sufficient evidence to suppress the next click, independent of whether the pixel
threshold was ever crossed. Not fixed yet — flagging for a future pass.

---

### Step 12 — Render polish (ghost, dimming, drop-target outline)

**Touches:** `media/overview.js`, inside and just after the existing `render()`
per-tile loop.

Three independent pieces, each keyed off state that already exists:

1. **Dim the dragged tile in its original slot** — *inside* the per-tile loop, when it
   reaches the tile matching `draggingFile`: wrap that one tile's normal drawing calls
   in a reduced `ctx.globalAlpha` (save/restore around it), reusing the same convention
   the subfolder-focus lowlighting already uses (CLAUDE.md cites opacity `0.15` for
   that case). Nothing else about how that tile draws changes — it's still sitting at
   its pre-drag `_cell` position, just faded.
2. **The ghost** — drawn *after* the per-tile loop (so it layers on top of everything,
   not underneath the next tile), only `if (draggingFile)`, at
   `{ x: dragPos.px - dragGrabOffset.x, y: dragPos.py - dragGrabOffset.y }`, sized to
   `draggingFile._cell.w/h`. Keep it cheap — a filled/stroked rect plus the filename as
   text, not a re-tokenized minimap; redrawing full syntax-highlighted content every
   frame during a drag would be wasteful and isn't what a "ghost" needs to convey.
3. **The drop-target outline** — also drawn after the loop, only `if (dragTargetFile)`:
   stroke `dragTargetFile._cell`'s bounds in an accent color. This is exactly why
   `updateDragTarget()` exists and runs every throttled `mousemove` frame — it keeps
   `dragTargetFile` live *during* the drag (tracking whatever's under the cursor as you
   move), rather than only getting resolved once at the final `mouseup`. Without that,
   this outline would never appear until after you'd already dropped, defeating the point.

No tweening/animation on the post-drop result — the grid just redraws once the updated
`"data"` message arrives, consistent with the rest of the codebase's snap convention.
None of these three change how any *other* tile draws.

- [ ] **Verify:** visually — ghost follows the cursor smoothly, drop target is clearly
  outlined and updates as you move over different tiles, dragged tile is visibly dimmed
  in its original slot, no jank or flicker at 60fps.

---

### Step 13 — Docs

**Touches:** `CLAUDE.md`, `DRAG_DROP_REORDER_PLAN.md`.

- Add `"reorderFile"`/`"setDragReorderMode"` to the `postMessage` protocol list in
  CLAUDE.md's "Cross-module interface" section.
- Add a "Non-obvious things worth knowing" bullet describing the order-array-only,
  layout-agnostic design.
- Update `DRAG_DROP_REORDER_PLAN.md`'s status line to "Implemented" (or delete it, per
  its own instruction, once the durable parts are folded into CLAUDE.md/DESIGN.md).
- Add a `CHANGELOG.md` entry when this ships in a release.

- [ ] **Verify:** re-read CLAUDE.md's updated bullet cold — does it explain the feature
  to someone who's never seen this doc?

---

### Step 14 — Full verification pass

Run all the scenarios from the plan doc's Verification section, now that everything is
built:

- [ ] Swap mode (default): drag one tile onto another in `uniform_grid` — exactly those
  two trade positions, nothing else moves.
- [ ] Shift mode: drag a tile several positions away — everything between old/new
  position shifts by one, nothing outside that range moves.
- [ ] `spanning_grid` with two very-different-height files — result is reasonable;
  cascading repack after them in that column is expected, not a bug.
- [ ] Shrink the panel to trigger subfolder-card/drilldown mode, drag there, zoom back
  out — reorder is visible at the root level too (this is what Step 1's fix enables).
- [ ] Small mousedown+mouseup with no movement still behaves as an ordinary click.
- [ ] `Escape` and dragging off-canvas both cancel with no order change.
- [ ] Order survives a rescan (edit+save a file) and a full reload.

---

### Step 15 — Known bugs to fix (found during testing, not yet fixed)

Three issues found so far, logged here so they don't get lost before Step 14's pass:

1. **Cross-canvas drag doesn't suppress the trailing click.** Already written up in full
   under Step 11 above (the `dragCandidate`-survives-`mouseleave`, `draggingFile`-never-
   gets-promoted trace) — not repeating it here, just flagging it as part of this list.

2. **Dragging onto or past the last file does nothing — confirmed root cause in swap
   mode.** `mouseup` (`overview.js:2099`) converts a resolved target of "the last file"
   into `targetId: null` to mean "append to the end." In **swap mode**,
   `PersistentFileOrder.swap(idA, idB)` (`state.ts:49`) does
   `const j = this.seenFiles.indexOf(idB)`, and `indexOf(null)` is always `-1` — so the
   guard `if (i === -1 || j === -1 || i === j) return;` unconditionally no-ops. That
   means in swap mode, dropping on or past the last tile does *nothing at all* — and
   worse, since the null-conversion fires for a **direct hit on the actual last tile
   too**, not just "past" it, the last tile is currently completely un-swappable by drag,
   not just un-appendable-past. **Shift mode's `move(idToMove, null)`** (`state.ts:55`)
   looks correct on inspection — `to = idTarget === null ? -1 : ...` then
   `splice(to === -1 ? length : to, ...)` does append at the true end — so this may be a
   swap-mode-only bug; needs confirming in both modes once F5-tested. Fix direction to
   consider: swap mode has no meaningful interpretation of "append to end" at all (you
   can't swap with "nothing") — the null-conversion in `mouseup` probably shouldn't apply
   in swap mode, so dropping on/past the last tile in swap mode just swaps with the
   actual last tile instead of trying to mean something it can't express.

3. **Nearest-fallback in `findNearestFile` (`overview.js:49`) searches the whole grid,
   not scoped to the current column/row.** Since files are laid out in a single
   deliberate flow order (not scattered), a raw whole-grid Euclidean-nearest search can
   resolve to a tile in a visually-close but semantically-unrelated column, which reads
   as a random jump rather than "the tile nearest where I dropped in my intended
   direction." Worth scoping the fallback to only the current column (or row) before
   falling back further. **Design tension to resolve, not just an implementation
   detail:** `spanning_grid` is column-major (`buildSpanningGrid` in `spanning_layout.ts`
   walks `seenFileOrder` stacking down each column before starting a new one), but
   `uniform_grid` is **row-major** (`buildStableGrid` in `layout.ts` pushes `[c, r]`
   row-by-row) — so "current column" is the right scope for `spanning_grid` but "current
   row" would be the equivalent for `uniform_grid`. A single column-only rule would be
   wrong in `uniform_grid` mode. This also cuts against the plan's original
   layout-agnostic principle (operate purely on the order array, no grid-geometry-aware
   code) — scoping by column/row means the drag code would need to know which mode is
   active, which the rest of this feature deliberately avoided. Worth deciding
   deliberately rather than bolting on silently.
