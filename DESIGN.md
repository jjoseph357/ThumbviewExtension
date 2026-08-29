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

**Original-case twin buffer.** Match Case and regex/whole-word search can't use the lowercased `_combinedText` buffer — lowercasing loses the information they need to match against. Rather than fall back to re-scanning `file.path`/`file.lines`/`file.fullLines` for those modes (which would reintroduce the per-keystroke GC pressure item 1 exists to avoid), an original-case sibling (`_combinedTextOriginal`) is built in the same pass at data-receipt time, so every search mode stays on a single pre-joined-buffer `.includes()`/`RegExp.test()` call, never a fresh scan.

**Why `_htmlCache` only holds syntax color, not search highlighting.** Line HTML caching (item 2) is a pure performance win when the cached content can't go stale — but a rendered tooltip line's *search* highlighting depends on the live query and its three toggles, which change independently of the line's own content. Baking the pink highlight into `_htmlCache` the first time a line is hovered meant it would silently show a previous query's highlight (or none) after the query changed and that same line was hovered again, since the cache is never invalidated. The fix splits the two concerns: `_htmlCache` keeps only the query-independent syntax-color spans (still cached, since token→color mapping never changes), while search highlighting is rebuilt from `line._tokens` fresh on every hover render. This reintroduces a small amount of per-hover work, but it's bounded to the ~25 lines the tooltip shows at once and already sits behind the `mousemove` `requestAnimationFrame` throttle, so it doesn't reopen the GC-pressure problem item 1 solved.

## Constant-Time Tab Set Lookup (`openFilesSet`)

Searching open tab arrays linearly (`openFiles.includes(file.uri)`) for every card on every frame render tick is an $O(N \cdot M)$ operation. Maintaining a `Set<string>` (`openFilesSet`) reduces open-tab border checks to $O(1)$ constant time.

## Top-Level Root Consolidation & Redundant Ignore Pruning

When a parent directory (e.g., virtual environment `BOFS/` or `.venv/`) contained 1,000 subdirectories, naive auto-ignore generated 1,000 redundant tree items in the sidebar. Aggregating ignore rules to top-level root folders (`BOFS/`) and pruning nested child paths keeps the ignore list clean, prevents memory degradation, and allows users to un-ignore top-level folders with a single click.

## Auto-Ignore Exclusion List (`autoIgnoreExclusions`)

Auto-ignore runs on every `scanRepository()` call, re-detecting dense folders from scratch. Without memory of prior user decisions, un-ignoring a folder only removed it from `ignorePatterns` — the very next scan would re-detect the same folder as dense and re-add it. The `autoIgnoreExclusions` persistent list solves this: when a user removes a directory pattern (ending with `/`) from ignores via the sidebar, it's added to `autoIgnoreExclusions`. The auto-ignore heuristic checks this list before adding any folder. This preserves auto-ignore's value for first-time discovery while respecting explicit user intent. Both lists are stored in `workspaceState` (see below).

## Ignore State in `workspaceState`, Not `.vscode/settings.json`

Prior to 0.2.7, `ignorePatterns` and `autoIgnoreExclusions` were stored using `ConfigurationTarget.WorkspaceFolder`, which writes to `.vscode/settings.json` inside the user's project. This caused the extension to silently create a `.vscode/` directory and `settings.json` file in repositories where none existed, polluting `git status` and risking accidental commits of extension-internal state.

Both values are now stored in `ExtensionContext.workspaceState` — VS Code's built-in per-workspace key-value store that lives in VS Code's internal data directory (`~/.config/Code/` or equivalent), never in the user's project. This is the same mechanism the extension already uses for `thumbview.seenFiles` and spanning layout allocations. On first activation after the migration, any old `settings.json` values are read, merged into `workspaceState`, and deleted from configuration so the `.vscode/settings.json` file can be safely removed.

## `repomap.*` → `thumbview.*` workspaceState key rename (0.3.1)

The file-order and spanning-layout persistence keys were originally named `repomap.seenFiles`, `repomap.spanningAllocations`, and `repomap.spanningRows`, left over from before the Repository Map → Thumbview rename (see CLAUDE.md's Terminology section). Renaming a `workspaceState` key isn't safe to do as a plain find-and-replace: existing users already have real data — file-to-grid-slot assignments and spanning allocations — sitting under the old key names. A bare rename would make the extension look up a key that's never existed for them, silently discarding that state and reshuffling their grid on next load.

Instead, `activate()` runs a one-time migration on every activation: for each `repomap.*` key that still has a value, copy it to the corresponding `thumbview.*` key (only if the new key isn't already populated) and delete the old key. This mirrors the `settings.json` → `workspaceState` migration above. Once we're confident essentially all users have activated the extension at least once past 0.3.1, the migration block and the old key names can be deleted outright, and the reads/writes can go back to plain `thumbview.*` literals with no fallback.

## Subdirectory & Root Directory Selection Lowlighting (Opacity 0.15)

Previously, selecting a subdirectory filtered out non-selected files completely and re-packed the remaining files. This broke spatial memory of where files live in the full repository grid. In 0.3.0, selecting a subdirectory retains all workspace file tiles in their stable grid slots while dimming non-selected files (`ctx.globalAlpha = 0.15`). Selecting "Root Directory Files Only" in Directory Navigation (or clicking a root file's header bar) similarly highlights only files located directly in the root workspace folder (`!file.path.includes("/")`) while lowlighting subdirectories. This keeps spatial layout consistent while highlighting the active directory or root level.

## Fixed Maximum Line Gap for Short Code Files (6px Cap)

Minimap canvas tiles divide tile height by line count (`stepY = h / lineCount`). For short files with few lines (e.g. 5–10 lines), naive division created large 15–20px vertical gaps between lines, stretching code structure artificially. Capping `stepY` at 6px max (`Math.min(h / lineCount, 6)`) ensures short files maintain standard 1:1 code line spacing with empty space at the bottom of the card, matching how developers naturally see code files in text editors.

## Fullscreen Mode via Zen Mode

The minimap needs the whole workbench to be readable — a single editor column squeezed between sidebar and panel restricts the canvas to a fraction of the monitor. Two constraints shaped the design:

1. **Extensions cannot read workbench visibility state.** There is no API or command to query whether the sidebar, panel, or auxiliary bar is visible ([microsoft/vscode#186581](https://github.com/microsoft/vscode/issues/186581)). Context keys like `sideBarVisible` exist but are not exposed to extensions, so snapshotting "what was open" in extension code is impossible.
2. **Blind toggles desync under concurrency.** `toggleMaximizeEditorGroup` flips global state with no way to read it. Earlier versions paired toggles with an optimistically-set boolean, but the command path and `onDidChangeViewState` both fired on panel creation, passed the flag check before either set it, and stacked toggles that cancelled each other — fullscreen worked only intermittently, and opening documents into a maximized group could spawn stray split groups.

The current design outsources the snapshot to VS Code itself:

1. **Zen Mode does the hiding and restoring.** `workbench.action.toggleZenMode` natively records and restores sidebar/panel/aux bar (and activity bar/tab bar) visibility. `zenMode.centerLayout`, `zenMode.fullScreen`, and `zenMode.hideActivityBar` are temporarily forced to `false`, `zenMode.showTabs` is forced to `"none"`, and `zenMode.singleTabGroup` is forced to `true` so the grid uses the full window and hides any split editors to the right of Thumbview; the original values are backed up in `workspaceState` and restored on exit, or on next activation if the session died mid-fullscreen. Settings with an explicit workspace-level value are left untouched. The left sidebar remains hidden during Zen mode, and all extension navigation, ignore management, and configuration controls are embedded directly in the webview top toolbar.
2. **Splits are maximized symmetrically — and always against the same group.** `toggleMaximizeEditorGroup` is paired with `zenMode.singleTabGroup` to guarantee isolation across split groups. So maximize (`maximizeThumbviewGroup`) runs only after the Thumbview panel is active, and unmaximize (in `exitFullscreen`) first re-reveals the panel if it isn't active, guaranteeing both toggles land on Thumbview's group.
3. **All layout ops are serialized, and view-state churn is suppressed.** `enterFullscreen`/`exitFullscreen` funnel through a single promise queue and set their state flags synchronously, so concurrent invocations can't stack. Zen/maximize shuffles focus, making the panel's `active` flag flicker — so `onDidChangeViewState` ignores events while a layout op is in flight (plus a 300ms grace window), and exits fullscreen only when the panel is actually *hidden* (`visible === false`), not merely inactive. `jump`/`switchTab` exit fullscreen *before* opening a document so editors never open into a maximized group.
4. **Speed comes from concurrency and ordering, not from skipping steps.** Fullscreen (zen) is entered *before* the panel is created or revealed, so Thumbview renders at full size immediately rather than snapping through intermediate layouts, with the group maximize following right behind it in the layout queue. On exit, `jump`/`switchTab` overlap the layout exit with the file's disk read (`openTextDocument`), so the editor appears as soon as both finish instead of after both run sequentially.

Exit runs from all leave paths: the toggle-off branch of `thumbview.open`, panel deactivation in `onDidChangeViewState`, and `onDidDispose`.

## Instant Hotkey Toggle & Retained Webview Context (`F4`)

In earlier versions, pressing the toggle hotkey (`F4`) to close Thumbview called `activePanel.dispose()`. This completely destroyed the webview panel, forcing a full repository rescan (`scanRepository()`) and line tokenization phase when reopening in large codebases.

In 0.3.1, pressing `F4` while Thumbview is active exits fullscreen (see "Fullscreen Mode via Zen Mode") and switches focus to the most recent editor tab (`workbench.action.openPreviousRecentlyUsedEditorInGroup`). Because the panel was created with `retainContextWhenHidden: true`, keeping the WebviewPanel alive in the background preserves its DOM canvas, line cache, and search index in memory. Pressing `F4` again instantly reveals the background panel with 0ms delay and zero scanning overhead. Closing the tab manually (`×` or `Ctrl+W`) disposes the panel as normal.

## Configurable Subfolder Card Threshold (`thumbview.minCellWidth` & `thumbview.minCellHeight`)

Large workspaces (hundreds of files) can produce grid cells too small to display a readable filename or be clickable. The webview evaluates tile dimensions against `thumbview.minCellWidth` (default `32px`) and `thumbview.minCellHeight` (default `28px`).
1. **Root File Tiles Visible**: When root file cells fit on screen above the minimum dimensions, selecting a directory (via sidebar Directory Navigation or path click) lowlights non-selected files (opacity 0.15), preserving full codebase grid layout.
2. **Directories Shrunk to Folder Cards**: When root cells drop below the minimum dimensions, directories shrink into clickable folder cards. Selecting a directory opens/drills down into that folder, constructing a complete Thumbview grid containing only that directory's files.

## Multi-Select Batch Deletion (`canSelectMany: true`)

Managing ignored patterns one by one from the sidebar tree view was tedious. Enabling `canSelectMany: true` on `thumbview-ignores` allows users to select multiple patterns via `Shift + Click` or `Ctrl + Click` and remove them in a single atomic VS Code configuration update.

## Modifier Key Hover Magnification (`Ctrl` Hold) & Throttling

Un-throttled hover magnifying tooltips running on raw high-frequency mouse movements over 5,000-line files caused UI stuttering and stole OS window focus when using `Alt`. 
1. Requiring `Left CTRL` hold to reveal code line magnification gives the user deliberate control and prevents accidental popup flickering while panning across tiles.
2. Throttling mouse hover evaluations with `requestAnimationFrame` ensures hover calculations execute at most once per frame (60 FPS).

## Automatic Panel Focus on Mouseover (`focusWindow`)

VS Code webviews do not automatically gain active input focus when hovering the mouse across editor groups. Triggering `activePanel.reveal(undefined, true)` on webview mouseover seamlessly restores active input focus to Thumbview without altering panel or editor column layouts.

## Two layout modes: `uniform_grid` vs `spanning_grid`

`spanning_grid` (the default) communicates a file's relative size and line count visually by having tall files span multiple vertical grid cells. `uniform_grid` is also available as an alternative mode (1 cell per file) via `thumbview.layoutMode`.

## Stable, incremental grid growth (`buildStableGrid`)

Users build spatial memory of where a file's tile lives ("that file is bottom-right of the grid"). If adding one new file to the workspace re-flowed every existing file to a new position, that memory would be invalidated on every git branch switch or scaffold step. So the grid only ever grows by appending new columns then new rows onto the existing layout (see the comment in `layout.ts`), and `PersistentFileOrder` (`state.ts`) guarantees a given file's array index — and therefore its slot — never changes just because other files came and went.

## Hole-filling instead of compaction (`PersistentFileOrder.update`)

Why a deleted file leaves a gap that's backfilled by a new file, rather than immediately compacting the array: same stability goal as above. Removing a file from the middle of the order and shifting everyone else down would move every subsequent file's slot. Backfilling a hole means only the newly-added file's position is "surprising"; nothing already on screen moves. The explicit **Reflow Layout** command exists for when a user *does* want to intentionally compact and reset — e.g. after a lot of churn has left many holes and the grid feels sparse.

## Hand-rolled `.gitignore` emulation & custom ignore patterns

`scanner.ts`'s `shouldIgnore` translates glob patterns to regular expressions without external dependencies. Rules are evaluated sequentially in order, supporting negation patterns (`!pattern`) where subsequent rules override preceding ones. In addition to workspace `.gitignore` files, custom ignore patterns from `workspaceState` are combined into the ignore filter and managed visually in the sidebar tree view.

## Sidebar Tree Views & Navigation

To improve navigation in large repositories where canvas headers are small:
1. **Directory Navigation Tree**: Built hierarchically in `directoryProvider.ts`. Focuses the Thumbview canvas to specific folders with accurate cumulative file counts (including subdirectories). Right-clicking a folder enables deleting it from disk (via confirmation modal) or revealing it in VS Code's File Explorer.
2. **Ignored Files & Directories Tree**: Built in `ignoreProvider.ts`. Allows adding, removing, multi-selecting (`canSelectMany`), deleting files/folders from disk (with trash or permanent options), and revealing items in VS Code's File Explorer.

## Unified Folders & Ignored Side-by-Side Modal

Users navigating dense workspaces needed an immediate way to inspect what folders are shown and what items are ignored without leaving the minimap canvas panel.
1. **Side-by-Side Visibility**: The `📁 Folders & Ignored` modal renders active folders on the left (with file counts, click-to-isolate, and one-click ignore) and all ignored directories and glob patterns on the right (with one-click unignore).
2. **Dedicated Folder Representation**: All auto-ignored and manually ignored folders are displayed with folder badges and icons in the ignored section.
3. **Isolated Input Focus**: Text input fields within the modal operate independently of the global minimap keydown listener, allowing users to type glob patterns directly without triggering search bar hijacking.

## Webview Context Menu & Pinned Editors

Right-clicking minimap file cards triggers a custom HTML context menu supporting standard VS Code Explorer actions (Open, Open to Side, Open Preview, Select for Compare, Compare with Selected, Reveal in Explorer, Open Containing Folder, Cut, Copy, Copy Path, Copy Relative Path, Rename..., Delete, Ignore in Thumbview). Jumping to files opens them with `{ preview: false }` to ensure tabs pin permanently and populate recency history.

## Host Safety Limits & Dynamic Hover Fetching

To prevent extension crashes or main thread freezes when scanning repositories with massive files or long minified code:
1. **File Size Cap**: Files over **2 MB** in size are skipped from initial workspace scanning.
2. **Line Length Truncation**: Lines are truncated at **300 characters** for minimap rendering.
3. **Evenly Spaced Line Sampling & Dynamic IPC Fetching**: For files over 2,000 lines, initial scanning samples up to **2,000 lines evenly spaced across the entire file** using uniform striding (`step = doc.lineCount / 2000`). This preserves the visual shape and structure of long files from top to bottom on the minimap card without overloading memory. `doc.lineCount` remains untruncated so tile heights and scrolling positions remain accurate. Any missing lines requested during hover overlay browsing are dynamically fetched on demand via `getHoverLines` IPC.
4. **Fixed Per-File Overlay Width**: Hover overlay tooltip width is fixed per file based on `min(maxWidthAllowed, widestLine)` across all available lines in that file. This prevents layout jitter/flashing as the cursor moves across lines of varying lengths in the same file.

## Centralized UI Chrome Colors & Fixed Brand Accents

Thumbview's UI chrome (webview HTML/CSS, canvas tile chrome, and editor jump-flash decoration) derives directly from the user's active VS Code theme using standard theme contribution variables (`--vscode-editor-background`, `--vscode-foreground`, `--vscode-menu-*`, `--vscode-focusBorder`, etc.). Three specific accents are intentionally fixed across all themes to preserve visual identity and accessibility:
1. **Search Accent (`#dc267f`)**: Used for search matching borders, highlighted token text, and editor jump fade-out decorations.
2. **Inspection Accent (`#785ef0`)**: Used for the interactive `Left CTRL` hold magnify tooltip hover marker and row border.
3. **Recency Accent (`#fe6100`)**: Used for the open editor tab indicator.

The constants are defined once in `src/colors.ts` and injected into the webview `<style>` as `:root { --tv-accent-* }` custom properties, where `media/overview.js` accesses them via `getThemeColor()`.

## Drag-and-Drop Grid-Slot Targeting & Empty Space Preservation

Drag-and-drop reordering resolves cursor positions to specific grid slots rather than nearest occupied tiles:
1. **Webview-Side `slotOccupancy` Map**: On each `"data"` message payload, `media/overview.js` populates an in-memory `Map<string, RepoFile>` (`slotOccupancy`) keyed by `"${col},${row}"`. Mouse movement and drag operations convert canvas pixel coordinates directly to clamped `[col, row]` coordinates, performing an $O(1)$ hashmap lookup. This allows empty slots to be directly addressable drop targets (`file === null`) and eliminates Euclidean distance search errors across columns.
2. **Host-Side `PersistentFileOrder` & Gap Preservation**: Tile arrangements are persisted as a `string[]` array in `workspaceState` under `"thumbview.seenFiles"`. When a user drags a file into an empty tile slot, the source slot is preserved as an empty placeholder (`""`) in the order array. In `uniform_grid`, the tile is assigned the target slot index via `findSlotIndex` without shifting intervening files. In `spanning_grid`, a 2D column-major slot grid model clears source cells and writes the file into target column/row coordinates while retaining empty placeholder cells, preventing cascading repack reflows.
3. **Reflow Action**: When users intentionally want to pack all empty spaces and eliminate gaps (e.g. after moving multiple files or deleting files from disk), the **Reflow Grid Layout** toolbar action and command reset the array strictly to active workspace files.

## Known limitations / accepted tradeoffs

- **No automated tests** (see README's "Notes" section). `layout.ts`/`state.ts` are pure functions/classes and would be straightforward to unit test; not yet done.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the webview, which does its own independent tokenization. Left unresolved as either dead code or an unfinished feature — see the comment at its definition.
- **No shared type definitions for the `postMessage` protocol** between `extension.ts` and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol drift is caught only by manual review/testing, not the compiler.
