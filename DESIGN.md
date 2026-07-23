# DESIGN.md

This document records the *why* behind Thumbview's architecture and behavior — decisions that aren't obvious from reading the code alone — and is the place to record new design decisions going forward, before or as they're implemented. See [CLAUDE.md](CLAUDE.md) for the *what* (file responsibilities, commands, common tasks).

## Extension host vs. webview split

VS Code sandboxes webview content: it gets a real browser context (canvas, CSS, `requestAnimationFrame`) but no direct access to the workspace file system or most of the `vscode` API. Full workspace access requires the extension host (Node). So scanning and file-system watching happen host-side (`extension.ts`, `scanner.ts`), and the result is pushed into the webview (`media/overview.js`) over `postMessage` for rendering — see CLAUDE.md's Architecture section for the message shapes.

## Why a single `<canvas>`, not one DOM element per tile

A workspace can have hundreds or thousands of files. Hundreds of absolutely-positioned DOM nodes, each with their own layout/paint/reflow cost, would be considerably slower to redraw on every resize, search keystroke, or cursor move than a single immediate-mode canvas repaint. Canvas drawing is cheap to fully redraw every frame; the DOM isn't designed to be entirely rebuilt on every keystroke. This also means there's no tile component state to manage — `render()` just redraws everything from `data` each time.

## Duplicated grid/tokenizer logic between host and webview

`media/overview.js` is loaded as a plain `<script>` (see the CSP in `extension.ts`'s `getHtml()`) — it cannot `import` the extension-host TypeScript in `src/`, which compiles to Node16 modules meant for the extension host's Node runtime, not a browser. So `layout.ts`'s `buildStableGrid` and `scanner.ts`'s per-line handling are effectively re-implemented independently on the webview side (the `buildStableGrid` duplicate, the `tokenizeJS`/`tokenizeCSS`/`tokenizeHTML` tokenizers). This duplication is an accepted tradeoff for now, not an oversight — a shared bundle (e.g. bundling a common module for both environments with esbuild) would remove it, but adds a build step this project doesn't currently have. Revisit if the two copies drift out of sync often enough to be a real maintenance cost.

## Parallel Chunked Workspace Scanning (`Promise.all` in Chunks of 50)

Sequential file reading (`async for ... of` with `await vscode.workspace.openTextDocument(...)`) created a 3–5 second blocking I/O bottleneck during initial workspace load on medium-to-large repositories. Batching disk reads into parallel chunks of 50 via `Promise.all()` provides a 5x–7x scan speedup (under 500ms) while preventing Node extension host event-loop thread starvation.

## Webview Canvas Viewport Frustum Culling

Redrawing code cards, lines, syntax tokens, and titles for hundreds of files that are scrolled offscreen or outside the visible window wastes significant GPU and CPU render ticks. Bounding-box frustum culling (`y + fileH < -50 || y > rectH + 50`) skips drawing offscreen cards completely, locking webview frame rate performance at 60 FPS even on large codebases.

## Pre-Computed Indexing (`file._combinedText`), Tokenization & HTML Caching

Executing string regex tokenization and lowercasing line strings repeatedly inside high-frequency 60Hz render loops caused heavy JavaScript Garbage Collection (GC) pauses during scrolling or typing. 
1. **`_combinedText` Buffer**: File paths and line texts are joined into a single lowercased string buffer (`file._combinedText`) upon data receipt, replacing multi-line search loops with a fast 1-pass native C++ `indexOf` lookup.
2. **`_tokens` and `_htmlCache`**: Syntax tokens and line HTML strings are pre-formatted once upon payload receipt or IPC fetching, eliminating per-frame string allocations.

## Constant-Time Tab Set Lookup (`openFilesSet`)

Searching open tab arrays linearly (`openFiles.includes(file.uri)`) for every card on every frame render tick is an $O(N \cdot M)$ operation. Maintaining a `Set<string>` (`openFilesSet`) reduces open-tab border checks to $O(1)$ constant time.

## Top-Level Root Consolidation & Redundant Ignore Pruning

When a parent directory (e.g., virtual environment `BOFS/` or `.venv/`) contained 1,000 subdirectories, naive auto-ignore generated 1,000 redundant tree items in the sidebar. Aggregating ignore rules to top-level root folders (`BOFS/`) and pruning nested child paths keeps the ignore list clean, prevents memory degradation, and allows users to un-ignore top-level folders with a single click.

## Multi-Select Batch Deletion (`canSelectMany: true`)

Managing ignored patterns one by one from the sidebar tree view was tedious. Enabling `canSelectMany: true` on `thumbview-ignores` allows users to select multiple patterns via `Shift + Click` or `Ctrl + Click` and remove them in a single atomic VS Code configuration update.

## Modifier Key Hover Magnification (`Ctrl` Hold) & Throttling

Un-throttled hover magnifying tooltips running on raw high-frequency mouse movements over 5,000-line files caused UI stuttering and stole OS window focus when using `Alt`. 
1. Requiring `Left CTRL` hold to reveal code line magnification gives the user deliberate control and prevents accidental popup flickering while panning across tiles.
2. Throttling mouse hover evaluations with `requestAnimationFrame` ensures hover calculations execute at most once per frame (60 FPS).

## Automatic Panel Focus on Mouseover (`focusWindow`)

VS Code webviews do not automatically gain active input focus when hovering the mouse across editor groups. Triggering `activePanel.reveal(undefined, true)` on webview mouseover seamlessly restores active input focus to Thumbview without altering panel or editor column layouts.

## Two layout modes: `uniform_grid` vs `spanning_grid`

`uniform_grid` (the default) is simplest: one cell per file, purely order-based, cheap to reason about and maximally stable. `spanning_grid` was added so a file's tile size communicates something about the file (its line count) instead of every file getting equal screen space regardless of size — useful once a workspace mixes many small files with a few large ones. The two modes are additive, not a replacement of one by the other, so users can pick based on preference via `thumbview.layoutMode`.

## Stable, incremental grid growth (`buildStableGrid`)

Users build spatial memory of where a file's tile lives ("that file is bottom-right of the grid"). If adding one new file to the workspace re-flowed every existing file to a new position, that memory would be invalidated on every git branch switch or scaffold step. So the grid only ever grows by appending new columns then new rows onto the existing layout (see the comment in `layout.ts`), and `PersistentFileOrder` (`state.ts`) guarantees a given file's array index — and therefore its slot — never changes just because other files came and went.

## Hole-filling instead of compaction (`PersistentFileOrder.update`)

Why a deleted file leaves a gap that's backfilled by a new file, rather than immediately compacting the array: same stability goal as above. Removing a file from the middle of the order and shifting everyone else down would move every subsequent file's slot. Backfilling a hole means only the newly-added file's position is "surprising"; nothing already on screen moves. The explicit **Reflow Layout** command exists for when a user *does* want to intentionally compact and reset — e.g. after a lot of churn has left many holes and the grid feels sparse.

## Hand-rolled `.gitignore` emulation & custom ignore patterns

`scanner.ts`'s `shouldIgnore` translates glob patterns to regular expressions without external dependencies. Rules are evaluated sequentially in order, supporting negation patterns (`!pattern`) where subsequent rules override preceding ones. In addition to workspace `.gitignore` files, custom ignore patterns defined in `thumbview.ignorePatterns` are combined into the ignore filter and managed visually in the sidebar tree view.

## Sidebar Tree Views & Navigation

To improve navigation in large repositories where canvas headers are small:
1. **Directory Navigation Tree**: Built hierarchically in `directoryProvider.ts`. Focuses the Thumbview canvas to specific folders with accurate cumulative file counts (including subdirectories).
2. **Ignored Files & Directories Tree**: Built in `ignoreProvider.ts`. Allows adding, removing, and multi-selecting (`canSelectMany`) ignore patterns directly from the sidebar.

## Webview Context Menu & Pinned Editors

Right-clicking minimap file cards triggers a custom HTML context menu supporting standard VS Code Explorer actions (Open, Open to Side, Open Preview, Select for Compare, Compare with Selected, Reveal in Explorer, Open Containing Folder, Cut, Copy, Copy Path, Copy Relative Path, Rename..., Delete, Ignore in Thumbview). Jumping to files opens them with `{ preview: false }` to ensure tabs pin permanently and populate recency history.

## Host Safety Limits & Dynamic Hover Fetching

To prevent extension crashes or main thread freezes when scanning repositories with massive files or long minified code:
1. **File Size Cap**: Files over **2 MB** in size are skipped from initial workspace scanning.
2. **Line Length Truncation**: Lines are truncated at **300 characters** for minimap rendering.
3. **Evenly Spaced Line Sampling & Dynamic IPC Fetching**: For files over 2,000 lines, initial scanning samples up to **2,000 lines evenly spaced across the entire file** using uniform striding (`step = doc.lineCount / 2000`). This preserves the visual shape and structure of long files from top to bottom on the minimap card without overloading memory. `doc.lineCount` remains untruncated so tile heights and scrolling positions remain accurate. Any missing lines requested during hover overlay browsing are dynamically fetched on demand via `getHoverLines` IPC.

## Known limitations / accepted tradeoffs

- **No automated tests** (see README's "Notes" section). `layout.ts`/`state.ts` are pure functions/classes and would be straightforward to unit test; not yet done.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the webview, which does its own independent tokenization. Left unresolved as either dead code or an unfinished feature — see the comment at its definition.
- **No shared type definitions for the `postMessage` protocol** between `extension.ts` and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol drift is caught only by manual review/testing, not the compiler.
