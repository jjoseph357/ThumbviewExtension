# Grid-slot drop targeting (rolls up 2 known bugs + 2 tabled feature requests)

> **Status:** Design only, not started. Written 2026-08-12 on `woody-dev`, superseding
> `DRAG_DROP_IMPLEMENTATION_STEPS.md`'s "Known bugs" (section 3) and "Tabled feature
> requests" (section 4) — those four items are folded into one plan here because they
> turn out to share a single root cause and a single fix. Companion docs:
> `DRAG_DROP_REORDER_PLAN.md` (original swap/shift design, now implemented) and
> `DRAG_DROP_IMPLEMENTATION_STEPS.md` (build log for that work).

## Why these four items are one problem

`findNearestFile` (`media/overview.js:74-95`) only ever knows about **occupied
cells** — it linear-scans `getFilteredFiles()`, hit-tests each file's `_cell`, and
falls back to whichever file's cell-center is Euclidean-closest to the cursor. It has
no notion of grid geometry (columns, rows, empty cells) at all, only a flat array of
file rectangles. Every open item traces back to that:

1. **Known bug 1 — last tile is un-swappable in swap mode.** `mouseup`
   (`overview.js:2007-2009`) converts "drop on/near the last tile" into
   `targetId: null` to mean "append to the end." In swap mode,
   `PersistentFileOrder.swap(idA, idB)` (`state.ts:49-53`) does
   `this.seenFiles.indexOf(idB)`, and `indexOf(null)` is always `-1`, so the guard
   `if (i === -1 || j === -1 || i === j) return;` unconditionally no-ops — dropping on
   the actual last tile does nothing.
2. **Known bug 2 — nearest-fallback can jump to the wrong column/row.** Because the
   fallback searches *every* occupied file by raw distance, a drop into visually empty
   space can resolve to a geometrically-closer file in an unrelated column instead of
   the nearest slot in the direction the user actually dragged.
3. **Tabled feature 1 — dropping into empty grid space does nothing.** There's no
   concept of an empty cell at all today — `buildStableGrid` (`layout.ts:34-58`) can
   overshoot `nCells` and leave trailing unused slots, and `buildSpanningGrid`
   (`spanning_layout.ts:96-123`) can leave empty cells at the bottom of the last column
   — but nothing hit-tests against them, so a drop there is silently absorbed by
   whichever occupied file happens to be nearest.
4. **Tabled feature 2 — size-aware swap in `spanning_grid`.** Swapping files of
   different cell spans has no defined geometry today; `PersistentFileOrder.swap()` is
   purely an order-array operation with zero concept of cell span.

All four disappear once drop targeting resolves to a **grid slot** (occupied or not)
instead of "the nearest file."

## The core idea: an internal grid-slot representation

The host already sends everything needed to reconstruct every slot's position, occupied
or not: `layout.cols`/`layout.rows` plus, per file, `.slot` (`[col, row]` of its
top-left cell), `.slots` (every cell it occupies), and `.nCells`
(`extension.ts:257-321`). The webview builds an occupancy map from this on every
`"data"` payload, alongside the other payload-time precomputation it already does
(`_combinedText`, tokenized-line caching):

```js
// col,row -> file, only for occupied cells; anything absent is empty
slotOccupancy = new Map();
for (const file of data.files) {
    for (const [c, r] of file.slots) {
        slotOccupancy.set(`${c},${r}`, file);
    }
}
```

`findNearestFile` is replaced with a slot-resolving equivalent — better name TBD at
implementation time, something like `findNearestSlot(px, py)` — that:

1. Converts the cursor position directly to a `[col, row]` via the same
   `sideMargin`/`topMargin`/`cellW`/`cellH` math `render()` already uses per mode
   (`overview.js:1417-1421`, `1599-1600` for the root grid; the equivalent
   `folderCellW`/`folderCellH` constants for drill-down), clamped to
   `[0, layout.cols - 1]` / `[0, layout.rows - 1]`.
2. Looks up that `[col, row]` in `slotOccupancy` — a **direct lookup**, not a
   distance search — and returns `{ col, row, file: slotOccupancy.get(key) ?? null }`.

Because the target column/row comes from cursor math against the *actual* grid
geometry rather than "whichever occupied file's center is closest," this can no longer
resolve to a tile in the wrong column (**fixes known bug 2** directly — there's no
Euclidean search left to go wrong) and it can resolve to `file: null` for a genuinely
empty cell (**fixes tabled feature 1** — an empty slot is now a first-class, directly
addressable drop target, not unaddressed blank canvas).

`findFileAt` (exact-hit-only, used for the general hover outline) is unaffected — it
still only needs to answer "is the cursor over a tile," which doesn't change.

### Design principle explicitly retired

`DRAG_DROP_REORDER_PLAN.md`'s original design deliberately kept drag-reorder logic
**layout-agnostic** — operating purely on the order array, no grid-geometry-aware code,
so it would generalize to future layout modes for free. Slot targeting breaks that on
purpose: it has to know `uniform_grid` is row-major (`buildStableGrid` pushes `[c, r]`
row-by-row) versus `spanning_grid` being column-major (`buildSpanningGrid` stacks a
file's cells down a column before starting the next), because the pixel-to-slot math
and the "first slot in this file's footprint" concept (used below) both depend on it.
**Decision: accept this.** There's no plan to add further layout modes, so there's no
real cost to paying for geometry-awareness now — this is a closed decision, not
deferred debt to revisit later.

## Resolving a drop

Once `findNearestSlot` returns `{ col, row, file }`, `mouseup`'s resolution becomes:

- **Slot occupied (`file` is set):**
  - **Swap mode:** `PersistentFileOrder.swap(draggingFile.id, file.id)` — unchanged
    from today, just now reached without the last-tile null-conversion hack. Dropping
    directly on the last tile's slot now means exactly what it looks like: swap with
    the last tile. **Fixes known bug 1** — there's no `targetId: null` path through
    swap mode at all anymore, so `indexOf(null)` never comes up.
  - **Shift mode:** `PersistentFileOrder.move(draggingFile.id, file.id)` — unchanged,
    inserts at that file's position and shifts the range between old/new position.
- **Slot empty (`file` is `null`):** there's nothing to swap *with*, so both modes
  collapse to the same operation — place the dragged file at that array position. This
  needs a `PersistentFileOrder` op that today's `swap`/`move` don't provide: `move()`
  only takes another file's id as the target (`state.ts:55-62`), never a raw slot/array
  position. Sketch: `placeAt(idToMove: string, index: number)` — remove `idToMove`
  from `seenFiles`, then splice it in at `index`. The remaining design question is
  computing `index` from `{col, row}`:
  - **`uniform_grid`:** `buildStableGrid` is called with `nCells: order.length`
    (`extension.ts:287`), so `layout.slots` is index-aligned with the order array —
    slot `i` *is* array index `i`. An empty slot at flat index `i < order.length`
    is a "hole" (a since-deleted file's stale id not yet reclaimed by
    `PersistentFileOrder.update()`); an empty slot at `i >= order.length` is pure
    row/column-batch overshoot with no array position at all, and placing there just
    means append-to-end.
  - **`spanning_grid`:** no such 1:1 index alignment exists — a column's empty tail
    cells don't correspond to any single array index. The practical resolution is
    likely "insert after whichever file's slot list ends closest above this empty
    slot in the same column" (i.e. move to just past that file's position), but this
    needs to be worked out concretely against `buildSpanningGrid`'s packing order
    before implementation, not assumed here.

## Size-aware swap (`spanning_grid`), simplified

The old tabled-feature writeup considered an asymmetric rule — small-into-big leaves a
gap, big-into-small cascades — and flagged it as a bigger change than it first sounds,
since the order array alone can't describe genuine gaps without `buildSpanningGrid`
gaining real gap-tracking. **Dropped in favor of one rule that reuses machinery
already built:**

Every spanning file's footprint is already known slot-for-slot
(`.slots`/`.nCells`, `spanning_layout.ts:108-119`) and `buildSpanningGrid` already
orders each file's own `slots` array with its lowest row first — i.e. **column-major,
first-slot-first** within a file's own footprint. When the dragged file and the drop
target differ in `nCells`, anchor the swap at the target's `slots[0]` (its first slot
in that existing column-major order) and place the dragged file there — no separate
"smaller" logic needed beyond that anchor choice, since `slots[0]` is well-defined
regardless of which file is bigger. The order-array swap/move then runs exactly as it
does today, and `buildSpanningGrid` fully repacks the affected column from the mutated
order array on the next layout refresh, same as any other reorder.

**Cascading repack after a size-mismatched swap is expected, not a bug** — this was
already called out as such in `DRAG_DROP_IMPLEMENTATION_STEPS.md`'s verification
checklist for the original feature, so no new exception needs to be documented. This
also means `uniform_grid` needs nothing extra here: every file there is `nCells: 1`, so
there's no size mismatch to be size-aware about, exactly as the original tabled
writeup noted.

## Files touched (expected)

- `media/overview.js` — new payload-time `slotOccupancy` map build (alongside existing
  `_combinedText`/tokenization precompute); `findNearestFile` replaced by a slot
  resolver; `mouseup`'s drop resolution rewritten to consume `{col, row, file}` instead
  of a nearest file, and the "closest-to-last-tile → `targetId: null`" special case
  removed entirely; `updateDragTarget()`/the drop-target outline render code updated
  to also outline an *empty* target slot (today it only draws
  `dragTargetFile._cell`, which won't exist for an empty slot — needs a
  geometry-derived rect instead).
- `src/state.ts` — new `PersistentFileOrder.placeAt(idToMove, index)` op (or
  equivalent) for empty-slot drops.
- `src/extension.ts` — `"reorderFile"` handler gains a branch for "drop targeted an
  empty slot" vs. today's swap/move-against-an-id; message shape likely grows an
  explicit empty-slot marker (`targetId: null` currently doubles as both "append to
  end" and "no file here," which is exactly the ambiguity that caused known bug 1 — the
  new shape should not repeat that overload).
- `CLAUDE.md` — the "Drag-to-Reorder is Order-Array-Only, Layout-Agnostic" bullet needs
  rewriting: it's no longer layout-agnostic (see "Design principle explicitly retired"
  above), and `findNearestFile` is renamed; `postMessage` protocol notes updated for
  any `"reorderFile"` shape change.
- `DRAG_DROP_IMPLEMENTATION_STEPS.md` — sections 3 and 4 marked superseded by this doc
  once work begins.

## Verification (once built)

1. Swap mode: drop directly on the last tile — confirm it swaps (known bug 1).
2. Swap mode: drop past the last tile into a trailing empty slot (when one exists,
   e.g. `uniform_grid` row/column overshoot) — confirm it moves to the end without
   touching the last tile.
3. Shift mode: dropping on a hovered tile's slot always takes that position; dropping
   on a trailing empty slot behaves as "move to end."
4. Drop into genuinely empty interior space in both `uniform_grid` (a reclaimed hole
   from a deleted file, before rescan reclaims it) and `spanning_grid` (short last
   column) — file relocates there, nothing else moves unexpectedly.
5. Nearest-slot targeting never resolves to a tile in a visually-unrelated column/row
   when dropping into empty space near the cursor (known bug 2 — should no longer be
   reproducible at all, not just "less likely").
6. `spanning_grid`, drag a small file onto a large one and vice versa — confirm both
   directions now follow the same rule (anchor at the target's first slot) and that
   the resulting repack is reasonable.
7. Full re-run of `DRAG_DROP_IMPLEMENTATION_STEPS.md`'s original verification list —
   nothing in ordinary swap/shift behavior regresses.
