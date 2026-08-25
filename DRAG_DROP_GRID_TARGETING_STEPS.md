<!-- # Grid-slot drop targeting — implementation tutorial -->

Companion to [DRAG_DROP_GRID_TARGETING_PLAN.md](DRAG_DROP_GRID_TARGETING_PLAN.md) (the
design) and [DRAG_DROP_IMPLEMENTATION_STEPS.md](DRAG_DROP_IMPLEMENTATION_STEPS.md) (the
original swap/shift build log). Written 2026-08-17. This doc is a **guided walkthrough**,
not a spec — each step explains what you're building and why before showing you where to
build it, and stops at a checkpoint you verify with `F5` before moving on. Code shown is
illustrative (matching the plan doc's own level of detail), not a drop-in patch — writing
it is the point.

Status: Steps 1–7 (Phases 1–3) landed and checkpointed 2026-08-17. Phase 4 (Step 8,
`spanning_grid` size-aware swap) needed a real design revision mid-implementation — the
original plan doc's claim that a plain `swap()`/`move()` "naturally" anchors the dragged
file at the target's old slot doesn't hold (worked counter-example below); the revised
Steps 8a/8b and Step 9 (CLAUDE.md) were then implemented directly (not hand-typed by you)
at your request once the design was settled — **not yet F5-checkpointed**, since that
step still needs your hands. Everything through Step 9 is condensed below into a
"Completed" section, same treatment `DRAG_DROP_IMPLEMENTATION_STEPS.md` gives finished
work. Line numbers reflect current code — expect drift as you edit.

**2026-08-17, later the same day — F5-testing Step 8b surfaced a real UX problem, not a
code bug.** Dragging a smaller file onto a bigger one works as designed (the dragged file
does start a fresh column where the target was), but whatever file originally sat right
below the target in that column visibly shifts up to backfill the rows the smaller file
doesn't use — because `forceBreakBeforeId` only pins *where the dragged file starts*, it
says nothing about what fills in after it, and `buildSpanningGrid` has no notion of a
genuinely empty (non-file-backed) cell to stop that backfill. This is the exact
"cascading repack is expected, not a bug" tradeoff both the original plan doc and your
own Step 8 redesign choice ("place the dragged file... and let the rest cascade")
explicitly signed off on — but seeing it live reads worse than the abstract description
did, so it's being reconsidered rather than left as a known-and-accepted quirk.
**Decision, to pick up next session: build real gap-tracking** — `buildSpanningGrid`
needs to represent genuine empty cells per column so freed rows actually stay empty
instead of being backfilled by whatever file comes next in array order. This is
materially bigger than Step 8b (touches the core packing algorithm's data model, not
just the swap call) and was the exact thing the original plan doc scoped *out* to avoid
("Dropped in favor of one rule that reuses machinery already built") — worth reading that
section again with fresh eyes before starting, since the tradeoffs it raised then are the
ones about to get paid for real. Not designed yet — next session starts from a blank page
on this, not from an in-progress Step 8c.

**Scope decision carried forward:** this tutorial builds root-grid targeting only.
Drill-down/subfolder-card mode (local re-layout via the `buildStableGrid` duplicate on a
`scopedFiles` subset) is called out at the point it becomes relevant and deliberately
deferred — same treatment the plan doc itself gives `spanning_grid` empty-slot indexing
("needs to be worked out concretely... not assumed here"). Trying to solve every mode at
once is how the original feature's "steps 1–11, WIP" commit happened; this tutorial is
structured to avoid that.

---

## Completed — Phases 1–2, Steps 1–5

**Foundation (Phase 1):** `slotOccupancy` — a module-level `Map`, declared once
(`const slotOccupancy = new Map()`, near `hoveredFile`) and `.clear()`-then-rebuilt on
every `"data"` payload rather than reallocated, matching the existing `imageCache`
clear-not-reallocate convention CLAUDE.md documents. Built inside the same per-file loop
that already does `_combinedText`/tokenization precompute (one more pass, not a second
loop), keyed `` `${col},${row}` `` from each file's `.slots` array.

`findNearestSlot(px, py)` replaced `findNearestFile` entirely (deleted, no remaining call
sites). Converts cursor position to `(col, row)` via the same margin/cell math
`render()` uses for the root grid (`GRID_SIDE_MARGIN`/`GRID_TOP_MARGIN`/
`GRID_BOTTOM_MARGIN`, deliberately duplicated the way `buildStableGrid` already is —
commented at both copies per the "duplicated logic must say so" convention), clamps to
grid bounds, and returns `{ col, row, file, cellW, cellH }` — `cellW`/`cellH` were added
to the return shape (not in the original sketch) specifically so the render code
consuming it (Phase 2) can't drift from the geometry math computed here. `file` is
normalized to `null` on a miss (`?? null`), not left as `Map.get`'s `undefined`, so
"empty slot" is a real checkable value everywhere downstream.

`updateDragTarget()` now sets module-level `dragTarget = findNearestSlot(...)`, with
`dragTargetFile` kept as a derived read (`dragTarget?.file ?? null`) so `mouseup` and the
ghost/outline render code kept working unmodified through this phase — confirmed via a
full re-verification pass that occupied-slot drag behavior is unchanged from before this
work started.

**Bugs caught and fixed while building this** (worth knowing if this code gets touched
again): `data.layout.row` → `.rows` typo that made every clamp resolve to `NaN`; a
template-literal lookup key written as `` `${a,b}` `` (JS comma operator inside one
interpolation, silently evaluating to just `b`) instead of `` `${a},${b}` `` , so the map
lookup never matched anything stored; the returned property names initially not matching
the `col`/`row` convention the rest of the code expects.

**Render polish (Phase 2):** the drop-target outline (overview.js, inside
`if (draggingFile) { … }`) now branches on `dragTarget.file` — occupied slot uses
`._cell` as before, empty slot derives its rect from `GRID_SIDE_MARGIN +
dragTarget.col * dragTarget.cellW` / `GRID_TOP_MARGIN + dragTarget.row * dragTarget.cellH`
(note the two different margin constants paired with x vs y — a copy-paste bug used
`GRID_SIDE_MARGIN` for both once during development and silently drew every empty-slot
outline 48px too high; caught before landing).

**`PersistentFileOrder.placeAt(idToMove, index)`** (`state.ts`) — new op alongside
`swap()`/`move()` for "put this file at a raw array index," which empty-slot drops need
since there's no other file's id to swap/move against. Implementation removes
`idToMove` first, then splices it back in at `index` adjusted for the shift that removal
itself causes (`index > from ? index - 1 : index`, clamped to
`[0, seenFiles.length]`) — verified by hand against forward-move, backward-move, and
past-the-end-append cases. (Earlier draft copied `move()`'s "re-look-up the id after
removal" pattern, which doesn't work here: `move()`'s pattern relies on the *target* id
still being in the array after `idToMove` is removed; `placeAt` has no such id, so
`indexOf(idToMove)` after its own removal always returned `-1` and silently dropped
`index` entirely, making every call behave as append-to-end. Fixed by using `index`
directly instead of trying to re-derive it via lookup.)

**Steps 6–7 — empty-slot placement, `uniform_grid`:** `slotToIndex(col, row, cols)`
(`layout.ts`, next to `buildStableGrid` — the row-major inverse, `row * cols + col`)
lives host-side only; the webview's job stops at sending `targetCol`/`targetRow` plus
`targetGridCols: data.layout.cols` (added to the `"reorderFile"` message specifically so
the host trusts the exact `cols` value the webview rendered against, rather than
recomputing a possibly-different one — `extension.ts` computes two different "cols"
numbers for `uniform_grid`, the raw grid `buildStableGrid` grows to internally vs. the
tight bounding box around actually-occupied columns that's the one actually sent to the
webview, and only the second is valid input to `slotToIndex`). The `"reorderFile"`
handler branches `if (msg.targetIsEmpty) { slotToIndex + placeAt } else { existing
swap/move }` — genuinely mutually exclusive, not two sequential `if`s (an early draft had
both able to fire on an empty-slot drop, falling through into `swap`/`move` against a
`null` target). `spanning_grid` hitting the empty-slot branch is explicitly guarded to
no-op (see Phase 4 below for why) rather than letting `uniform_grid`-only row-major math
run against a column-major layout. The old "closest-to-last-tile → `targetId: null`"
hack in `mouseup` is deleted entirely — known bug 1 (last tile un-swappable) is fixed
because there's no null-conversion left to trip over `PersistentFileOrder.swap`'s
`indexOf(null) === -1` guard.

**Follow-up not covered by this tutorial:** `spanning_grid` empty-slot placement. The plan
doc's working hypothesis is "insert after whichever file's slot list ends closest above
this empty slot in the same column," but flags that it needs to be worked out concretely
against `buildSpanningGrid`'s packing order before implementation — treat that as its own
mini version of Phase 3 once you get here, not something to improvise inline.

---

## Phase 4 — Size-aware swap in `spanning_grid`

**Goal:** dragging a file onto a target of a *different* `nCells` (spanning multiple
cells) produces a sensible result instead of undefined behavior. Independent of Phase 3 —
this is about occupied-slot swaps between differently-sized files, not empty slots.

**Revised 2026-08-17 — the original Step 8 design doesn't hold.** The plan doc claimed a
plain `fileOrder.swap(sourceId, targetId)` would "naturally" land the dragged file at the
target's old column once `buildSpanningGrid` repacks — no extra logic needed beyond
knowing *that* the sizes differ. A worked trace disproves this:

Order `[A(1), B(1), C(3), D(1), E(1)]`, `gridRows=3` packs as
`A@(0,0) B@(0,1) C@(1,0-2) D@(2,0) E@(2,1)`. Dragging small `D` onto big `C` — intent:
`D` takes over column 1. A raw `swap(D, C)` gives order `[A,B,D,C,E]`; repacking that
produces `A@(0,0) B@(0,1) D@(0,2) C@(1,0-2) E@(2,0)` — **`C` doesn't move at all.** Column
0 had exactly one empty row left (`A`+`B` only used 2 of `gridRows=3`), so `D` just fell
into that gap instead of displacing `C`. `buildSpanningGrid`'s column-major packer is a
greedy walk driven purely by cumulative cell-counts up to each array position — it has no
notion of "make room for this specific file here," so a bare array-position swap can land
the dragged file somewhere with no visual relationship to the target at all, not just "a
cascading repack" (which was already disclosed as expected) but potentially *no visible
effect near the target whatsoever*.

**Revised design — force a column break for the dragged file specifically:**

### Step 8a — Read `nCells` for source/target without widening the message

**Why:** deciding *how* to reposition needs to know both files' cell counts, but
`"reorderFile"` only ever carries ids. Don't add `nCells` to the message — the host
already has an authoritative, persisted source: `context.workspaceState`'s
`"thumbview.spanningAllocations"` (`{ [id: string]: number }`), written on every
`spanning_grid` payload build (`extension.ts:254`) specifically so cell counts stay
stable across rescans (`spanning_layout.ts:38-41`).

**Where:** inside the `"reorderFile"` handler's occupied-slot branch (`extension.ts`,
the `else` of the `targetIsEmpty` check), only relevant `if (getLayoutMode() ===
"spanning_grid")`.

**What to write:**
```ts
const allocations = context.workspaceState.get<{ [id: string]: number }>("thumbview.spanningAllocations") || {};
const sourceCells = allocations[msg.sourceId] ?? 1;
const targetCells = allocations[msg.targetId] ?? 1;
```

**Pre-existing bug, worth knowing but not part of this feature:** `extension.ts:249`
*reads* allocations back from the stale key `"repomap.spanningAllocations"` (pre-rename),
while `:254` *writes* to the correct `"thumbview.spanningAllocations"`. Once the one-time
migration deletes the old `repomap.*` keys, that read always returns `{}`, silently
defeating the whole point of persisting allocations. Doesn't block Step 8a — the read
above targets the correct key, which the existing (buggy-elsewhere) write path keeps
populated regardless — but flag it separately for a real fix later.

**Status: code written (implemented directly at your request, not hand-typed), not yet
F5-checkpointed.** `extension.ts`'s `"reorderFile"` handler now reads `allocations` from
`context.workspaceState` and compares `sourceCells`/`targetCells` to decide
`sizeMismatch` before choosing which branch to take.

- [ ] Step 8a checkpoint still needed: log `sourceCells`/`targetCells` for a known
  mismatched pair, confirm they match what you'd expect from the files' visible sizes

### Step 8b — Force a column break in `buildSpanningGrid` for the dragged file

**Why:** the trace above shows position alone can't guarantee where the dragged file
lands — the greedy packer will backfill any column that has room, regardless of intent.
The only reliable way to make the dragged file start *exactly* where the target used to
be is to tell the packer "don't try to fit this specific file into whatever column
precedes it — force a fresh column," bypassing the normal `currRow + item.nCells >
gridRows` fit-check for one specific id.

**Where:** `spanning_layout.ts`'s `buildSpanningGrid` (the packing loop at
`spanning_layout.ts:100-123`).

**What to write:** add an optional parameter, e.g. `forceBreakBeforeId?: string`. In the
loop, force the break condition when the current item's id matches, in addition to the
existing fit-check:
```ts
if (item.id === forceBreakBeforeId ? currRow > 0 : (currRow > 0 && currRow + item.nCells > gridRows)) {
    currCol++;
    currRow = 0;
}
```
(`currRow > 0` alone, not unconditional — if the dragged file already happens to land at
the top of a fresh column naturally, forcing another break would waste a whole empty
column for nothing.) This only fires for the one id passed in, so ordinary rescans
(which never pass `forceBreakBeforeId`) are completely unaffected — worth confirming by
re-reading the diff once written: every other call site should be passing `undefined`
implicitly.

**Then, in `extension.ts`:** thread the id through from the `"reorderFile"` handler to
`buildSpanningGrid`'s caller. `updateLayoutFromCache` (`extension.ts:215`) is the shared
function ordinary rescans also call, so it now takes an optional second parameter
(`forceBreakBeforeId?: string`) rather than a module-level flag — a flag would risk
leaking into an unrelated rescan that happens to race with it.

**Correction from the original sketch above — `swap()`, not `move()`.** Actually
implementing this surfaced a second subtlety: `move(idToMove, idTarget)` is
direction-dependent. If the dragged file originally sat *before* the target in the array,
removing it and re-inserting before the target's (now-shifted) index lands it one slot
*before* the target's original position, and — because indices before the removal point
are untouched — the target itself doesn't move at all. If the dragged file originally sat
*after* the target, it lands exactly at the target's original index instead, matching
what you'd want. `swap(idA, idB)` doesn't have this asymmetry — it always trades exactly
two array positions, so the dragged file always ends up precisely at the target's
original index and the target always ends up at the dragged file's original index,
regardless of drag direction. So the implemented size-mismatch branch is:
```ts
fileOrder.swap(msg.sourceId, msg.targetId);
forceBreakBeforeId = msg.sourceId;
```
unconditionally (not gated on `dragReorderMode` — a size mismatch overrides swap/shift
mode entirely, since `move()`'s whole-range-shift semantics don't have a coherent meaning
once a forced column break is also happening). Same-size `spanning_grid` drops fall
through unchanged to the existing `mode === "shift" ? move() : swap()` branch.

**Status: code written (implemented directly at your request, not hand-typed), not yet
F5-checkpointed.**

**Checkpoint still needed:**
- [ ] Re-run the worked trace by hand against your own actual repo's file sizes/order —
  confirm the dragged file now genuinely starts a fresh column where the target used to
  be, not absorbed into a preceding column's leftover space.
- [ ] Drag a small file onto a large one in `spanning_grid` — small file takes over the
  target's old column (possibly wasting rows if it's much smaller — expected, not a bug).
- [ ] Drag a large file onto a small one — same check, other direction; confirm the
  now-larger occupant pushes subsequent columns over as needed.
- [ ] Confirm an *ordinary* rescan (edit+save a file, no drag involved) still packs
  exactly as before — `forceBreakBeforeId` must never leak into that path.
- [ ] `uniform_grid` mode's occupied-slot swap/move (Phase 1's behavior) is completely
  unaffected — this phase only touches the `spanning_grid` code path.
- [ ] Same-size `spanning_grid` drops (the common case — most files are 1 cell) still
  respect `dragReorderMode` exactly as before; only mismatched sizes bypass it.

---

## Phase 5 — Docs and full verification

**Why this is its own phase, not an afterthought:** CLAUDE.md's documentation-currency
rule applies here — the "Drag-to-Reorder is Order-Array-Only, Layout-Agnostic" bullet
becomes actively wrong once Phase 1 lands (the plan doc's "Design principle explicitly
retired" section explains why: slot targeting has to know row-major vs column-major,
which the original design deliberately avoided).

### Step 9 — Update CLAUDE.md — done

- [x] Rewrote the "Drag-to-Reorder..." bullet (now titled "Drag-to-Reorder resolves to a
  grid slot, not the nearest file — and is no longer layout-agnostic") to cover
  `slotOccupancy`, `findNearestSlot` (renamed from `findNearestFile`), `slotToIndex`,
  `placeAt`, the `spanning_grid` empty-slot guard, and the Phase 4 size-aware swap
  (`spanningAllocations` lookup + `forceBreakBeforeId`) — folded into one bullet rather
  than split across several, since it's all one coherent design decision.
- [x] Fixed the adjacent "General Hover Outline" bullet's stale `findNearestFile`
  reference to `findNearestSlot`.
- **Deviation from the original plan for this step:** rather than listing individual
  field names in the `postMessage` protocol's command-name list (`"Cross-module
  interface"`), added a short shape-comment at both call sites instead
  (`media/overview.js`'s `mouseup`, `extension.ts`'s `"reorderFile"` handler) — matching
  what CLAUDE.md's own convention actually says to do ("note its fields in a short
  comment at both ends"), rather than growing the one-line command list with per-field
  detail it doesn't carry for any other command either.
- [ ] **Verify still needed (do this yourself, cold):** re-read the updated bullet — does
  it explain the slot-targeting design without assuming you remember building it?

### Step 10 — Full verification pass

Run every item in the plan doc's own Verification section
(`DRAG_DROP_GRID_TARGETING_PLAN.md`, bottom) plus a full re-run of
`DRAG_DROP_IMPLEMENTATION_STEPS.md`'s original checklist (Remaining Work section 2) —
nothing in ordinary swap/shift behavior should have regressed across five phases of
changes.

- [x] Step 9 done (verify-cold check above still yours to do)
- [ ] Step 10 done — feature complete
