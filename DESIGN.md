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

Large workspaces (hundreds of files) can produce grid cells too small to display a readable filename or be clickable. The webview evaluates tile dimensions against `thumbview.minCellWidth` (default `60px`) and `thumbview.minCellHeight` (default `40px`).
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

## Diagnostic Error Highlighting & Title Color Hierarchy

Thumbview listens to VS Code language diagnostics (`vscode.languages.onDidChangeDiagnostics`) to detect syntax and compilation errors across the workspace in real time:
1. **File Title Color Precedence**: Card titles resolve in priority order: Search Match (`#dc267f`) > Error (`--vscode-list-errorForeground` / `#f14c4c`) > Git Modified (`--vscode-gitDecoration-modifiedResourceForeground`) > Git Added/Untracked (`--vscode-gitDecoration-untrackedResourceForeground`) > Active Editor (`--vscode-foreground`) > Default (`--vscode-descriptionForeground`). Files containing any Error-level diagnostic immediately display red titles to draw immediate attention.
2. **Minimap Overview Line Highlighting & Git Deletion Carets**: Lines with active errors render a full-width red background (`rgba(239, 68, 68, 0.22)`) and red gutter indicator (`rgba(239, 68, 68, 0.85)`). Git deletions render as red gutter triangle carets (`▶`) on the left margin rather than full-width stripes, keeping full-width row fills reserved for active lines. When inspecting code with Left CTRL hold, offending lines display `✕` error icons and diagnostic messages, while deleted lines display `-` prefixes and strikethrough text.
3. **Viewport Band Transparency**: The gray viewport band overlay representing the open editor range (`viewportBandOverlay`) uses subtle `rgba(255, 255, 255, 0.08)` transparency so Git modified blue highlights and added green highlights remain visible underneath without color pollution.

## Drag-and-Drop Grid-Slot Targeting & Empty Space Preservation

Drag-and-drop reordering resolves cursor positions to specific grid slots rather than nearest occupied tiles:
1. **Webview-Side `slotOccupancy` Map**: On each `"data"` message payload, `media/overview.js` populates an in-memory `Map<string, RepoFile>` (`slotOccupancy`) keyed by `"${col},${row}"`. Mouse movement and drag operations convert canvas pixel coordinates directly to clamped `[col, row]` coordinates, performing an $O(1)$ hashmap lookup. This allows empty slots to be directly addressable drop targets (`file === null`) and eliminates Euclidean distance search errors across columns.
2. **Host-Side `PersistentFileOrder` & Gap Preservation**: Tile arrangements are persisted as a `string[]` array in `workspaceState` under `"thumbview.seenFiles"`. When a user drags a file into an empty tile slot, the source slot is preserved as an empty placeholder (`""`) in the order array. In `uniform_grid`, the tile is assigned the target slot index via `findSlotIndex` without shifting intervening files. In `spanning_grid`, a 2D column-major slot grid model clears source cells and writes the file into target column/row coordinates while retaining empty placeholder cells, preventing cascading repack reflows.
3. **Reflow Action**: When users intentionally want to pack all empty spaces and eliminate gaps (e.g. after moving multiple files or deleting files from disk), the **Reflow Grid Layout** toolbar action and command reset the array strictly to active workspace files.

## Preserving File Positions on Folder Unignore (`integrateNewFilesPreservingPositions`)

When unignoring a folder with many files, naive grid packing reshuffles existing files as `wrapRows` or total cell count expands. To preserve visual muscle memory:
1. Existing file placements are preserved at their exact `(col, row)` coordinates in a 2D matrix.
2. New files first fill remaining empty rows in existing columns (below existing cards).
3. Any remaining new files expand into new columns to the right.
This ensures existing cards never reflow or jump away when unignoring folders.

## Tall File Vertical Overflow Protection

In spanning grid mode, tall files occupy multiple vertical cells (`nCells`). When the window or webview vertical height shrinks, a tall file whose pixel height (`nCells * cellH`) exceeds the canvas vertical bounds (`availableH` or `rectH`) would otherwise be clipped or disappear offscreen.
Thumbview detects `hasTallFileOverflow` during layout calculation and automatically toggles `rootCellsTooSmall = true`. This cleanly transforms the view into subfolder cards mode so files remain accessible and legible without clipping.

## Reorder Gesture Performance (Token Cache & Offscreen Drag Canvas)

1. **`fileTokenCache`**: Re-tokenizing lines and creating combined text buffers for every file on every tile drop payload incurred heavy synchronous overhead. Caching tokenized lines and combined text strings keyed by file ID, line count, and line 0 content skips re-tokenizing unchanged files, reducing drop processing to under 2ms.
2. **`cachedDragBackgroundCanvas`**: Reuses an offscreen canvas across drag operations rather than creating and discarding DOM elements during tile pickup, keeping drag animations locked at 60 FPS.

## Folder Cards Empty Space Drop Synchronization

When dragging cards in subfolder cards overview, the host synchronizes `thumbview.cardOrder` using the current card order snapshot sent from the webview (`msg.currentCardIds`). Dropping into an empty space places the card at the exact target slot index rather than appending it to the far right.

## Subfolder Cards Mode Uniform Layout & In-Folder Drag Stability

1. **Uniform 1-cell layout**: In subfolder cards mode (`cellsTooSmall === true`), all folder cards and root file tiles render with uniform 1-cell dimensions (`localCellH = availableH / cardRows`). This maintains a clean, uniform visual hierarchy and predictable grid alignment across all cards.
2. **In-Folder Drag Stability**: Within a subfolder card or folder drill-down view (`focusedFolder`), dragging and dropping files strictly respects the layout's column wrap stride (`gridRows = wrapRows`). Swapping two files places the target item into the source file's vacated slot so neither file is lost or shifted. Moving a file to an empty space preserves the exact coordinates of all other files in the folder without cascading downstream tiles into adjacent columns. Folder file reorders update `thumbview.folderOrders` without mutating the workspace-wide `fileOrder`.

## Leaf Node Folder Spanning Grid Representations

When viewing or drilling down into a folder at the leaf node of subdirectories (a directory that contains only files, with no child subdirectories), subfolder cards mode cannot apply because there are no child folders to represent as cards. The files within leaf node folders strictly retain their spanning grid representation (`localSpanningLayout`) with multi-cell heights reflecting line counts. In subfolder cards overview, preview tiles inside leaf node folder cards also render spanning grid representations.

## Dynamic Tile Height Expansion on Line Count Growth

Adding lines to a file dynamically refreshes cell allocations via `cellsNeeded(f.lineCount)`. Stale persisted allocations in `workspaceState` are refreshed before calling `buildSpanningGrid`, allowing tiles to expand dynamically from 1 cell up to multi-cell heights (e.g. 9 cells for a 10,000 line file). Tolerances (`+ 1px`) on vertical bounds checks prevent IEEE 754 floating-point rounding errors (`(availableH / gridRows) * gridRows > availableH`) from triggering false-positive overflow collapses.

## Nested Folder Cards & Variable Spanning Heights in Previews

In folder cards mode, parent folder cards inspect child subdirectories using `getSubfolderGroups(group.files, group.path)`. When child subfolders exist, mini folder cards are rendered inside the preview mosaic rather than flattening all recursive files into a single flat grid. Additionally, preview files preserve variable spanning heights (`nCells` derived from `cellsNeeded(f.lineCount)`) through `buildSpanningGridLocal` so files of different lengths (e.g. 1-tile vs 3-tiles tall) accurately reflect their proportional heights within folder card previews.

## In-Folder Grid Sizing & Empty Slot Targeting

In folder drill-down uniform views, `localFolderGrid` generates slots spanning the entire grid dimensions (`folderCols * folderRows`), rather than capping at `scopedFiles.length`. This ensures that coordinates for empty grid slots resolve to valid slot indexes (`slotIdx !== -1`), preventing dropped tiles from defaulting to top-left positions. In both spanning and uniform folder views, drops route through `thumbview.folderOrders[focusedFolder]` with up-to-date line count allocations.

## Drag-and-Drop Latency Elimination (Instant Pickup, Optimistic Release, Memoized Ignores)

1. **Instant Pickup Snapshot**: When a drag gesture crosses `DRAG_THRESHOLD`, the webview immediately blits the current canvas into `cachedDragBackgroundCanvas`, dims the candidate tile, and assigns `dragBackgroundCanvas = cachedDragBackgroundCanvas`. The very first frame of dragging utilizes the snapshot blit, eliminating the full-canvas synchronous redraw that previously caused pickup stutter.
2. **Optimistic In-Memory Drop**: On `mouseup`, `media/overview.js` updates `data.folderOrders[focusedFolder]` in memory immediately before rendering, providing instant zero-latency visual confirmation of the new position while the extension host persists changes asynchronously.
3. **Memoized Ignore Counts**: The extension host caches `computeIgnoreCounts` results keyed by pattern set and file count, eliminating redundant $O(N \cdot M)$ regex sweeps across the workspace during drag reorders.

## Folder Card Preview Fidelity with Drill-Down Views (`doesFolderCollapse`)

The purpose of a folder card preview is to provide users with a 1:1 preview of what they will see when they click into that folder. Previously, preview generation unconditionally rendered nested subfolder cards if any child folders existed, even when drilling down into the folder would lay out all files individually because the file count was small enough to fit within comfortable cell dimensions.
To ensure total visual consistency, both folder card previews and folder drill-down views rely on a shared single source of truth: `doesFolderCollapse(files, folderPath)`. If `doesFolderCollapse` returns false, the preview displays all individual files with their accurate proportional spanning heights using `buildSpanningGridLocal`. If `doesFolderCollapse` returns true (e.g. dense directories with child subfolders that would exceed readability thresholds), the preview uses the exact same row-major `buildStableGrid` layout that subfolder card mode uses, ensuring child folder cards appear in their identical positions (e.g. straight line along the bottom) rather than an artificial column-major L-shape.

## Window, Sidebar, and Terminal Resize Stability & Readability Collapse

Resizing VS Code's window, dragging sidebar edges, or toggling terminal panels smoothly scales the visible tiles without rearranging them into different rows or columns:
1. **Constant Grid Aspect Ratio (`BASE_GRID_ASPECT = 16 / 9`)**: Enforcing a constant `BASE_GRID_ASPECT = 16 / 9` across `buildSpanningGridLocal` and `buildStableGrid` ensures that layout slots `(col, row)` remain invariant. Cell dimensions scale proportionally (`availableW / cols`, `availableH / rows`), eliminating reflow.
2. **Readability-Triggered Collapse on Window Shrink**: When reducing the IDE window to the point where files become physically unreadable (`cellW < minCellWidth || cellH < minCellHeight`), views containing child subdirectories collapse into folder thumbnail cards. This allows dense or leaf folders with subdirectories to stay accessible when screen real estate is constrained, while avoiding reflow on minor window adjustments.

## Folder Card Reordering, Empty Rows Below, & Grid Space Clamping

1. **Capacity Allocation for Rows Below**: In subfolder cards mode, `buildStableGrid` bases its capacity on `Math.max(orderedItems.length, displayItems.length, effectiveCardOrder.length)`. This ensures that when cards are dropped into empty rows below, the grid allocates sufficient rows and slots, preventing cards from vanishing and keeping rows below fully addressable by drag-and-drop targeting.
2. **Strict Grid Column Clamping on Drag**: The maximum column allowable during drag operations (`maxAllowedCols`) is strictly clamped to the active rendered grid columns (`targetGridCols`). It never duplicates `extraCols`, preventing rightward drags from generating phantom columns. Grid expansion is strictly preserved as a manual user action via right-click > "Expand Grid Space".
3. **Card Reordering Scoped to Folder**: Swapping items within a folder card updates `thumbview.folderOrders[folder]` without mutating global root `fileOrder`, isolating folder-level arrangements from workspace-wide layout state.

## Mouse Side Button Navigation Deduplication

Mouse button 3 (Back) and button 4 (Forward) events are handled exclusively in `mouseup`. In standard browser DOM, physical clicks emit `mouseup` immediately followed by `auxclick`. Handling both resulted in double-firing `handleBreadcrumbBack()`, skipping two history levels in a single click. Suppressing the action in `auxclick` guarantees clean 1:1 step-back navigation per physical click.

## Zero-Flicker 2D Spanning Drag-and-Drop Reordering

Dragging files in spanning mode previously caused visual stutter: untouched files in adjacent rows/columns momentarily shifted into incorrect positions on `mouseup`, only to jump back to their correct positions a fraction of a second later when the host confirmation arrived.
1. **Root Cause**: The webview performed a naive 1D array swap or row-major index insertion on a column-major spanning list on `mouseup`. When `buildSpanningGridLocal` repacked the list sequentially, variable-height tiles spilled across column boundaries, shifting untouched files.
2. **Local 2D Spanning Calculation (`reorderSpanningItemsLocal`)**: The webview now mirrors the host's `reorderSpanningItems` logic directly on `mouseup`. It constructs the 2D column-major grid, swaps the source and target items without disturbing any other cell, and updates in-memory order. Untouched files remain strictly locked to their exact `(col, row)` coordinates.
3. **Synchronous Host Dispatch**: `extension.ts` calls `updateLayoutFromCache(activePanel)` synchronously before awaiting asynchronous `context.workspaceState.update(...)` disk writes, reducing host confirmation latency from 300ms to < 2ms and matching the webview's optimistic layout with zero visual jump.

## Folder Card Order & File Order State Isolation (`thumbview.folderCardOrders`)

Previously, inside folder drill-downs, `thumbview.folderOrders[folder]` was shared between the uncollapsed file view (e.g. 50 files) and the collapsed folder card view (e.g. 3 cards). When a folder collapsed, `effectiveCardOrder` inherited the 50 file IDs, generating 50 items in `displayItems`. The grid was sized for 50 items (10x5 grid), causing cards to squish into tiny corner slivers and leaving 47 slots empty.
1. **Isolated Persistence Keys**: Folder card ordering is stored in dedicated `thumbview.folderCardOrders[folder]`, while uncollapsed file ordering remains in `thumbview.folderOrders[folder]`.
2. **Safe Card Filtering & Canvas Sizing**: When `cellsTooSmall` is active, `effectiveCardOrder` filters out stale or unmapped IDs from previous file views. `totalItems` strictly equals the count of actual subfolder cards and root files (e.g. 4), sizing the grid to 2x2 and allowing cards to expand to 100% of the available canvas width and height.

## Pure Zoom Grid Expansion & Zero-Reflow Scaling

The user specification requires that "Expand Grid Space" and "Reduce Grid Space" act purely as zooming out or in, adding or subtracting space symmetrically along both rows and columns to maintain the 16:9 aspect ratio, scaling all files down into the top-left corner without ever reflowing or rearranging their positions.
1. **Root Cause of Unbalanced Reflow**: Previously, `triggerExpandSpace` and `triggerReduceSpace` invoked `expandSpanningGridOrderLocal` and `reduceSpanningGridOrderLocal`, which modified 1D order arrays, injected empty placeholders `""`, altered `wrapRows`, and in reduce mode deleted files placed beyond the reduced dimensions. Changing `wrapRows` altered the column packing stride, causing line breaks (`currRow + nCells > wrapRows`) to occur at completely different file boundaries and violently reflowing tiles.
2. **Pure Zoom Architecture**:
   - `triggerExpandSpace()` and `triggerReduceSpace()` purely adjust `extraCols` and `extraRows` (+1 / -1), leaving `data.fileOrder`, `data.cardOrder`, `data.folderOrders`, and all `wrapRows` 100% untouched.
   - When expanding (zooming out), 1 column and 1 row are added (`extraCols + 1`, `extraRows + 1`). Tiles shrink slightly and move towards the top-left corner, opening empty rows and columns to the right and bottom while maintaining the aspect ratio.
   - When reducing (zooming in), 1 column and 1 row are removed (`extraCols - 1`, `extraRows - 1`), clamped so `extraCols >= 0` and `extraRows >= 0`, never reducing below the base bounding box or cutting off placed files.
   - Placements in `buildSpanningGridLocal` and `buildSpanningGrid` maintain identical coordinates because `wrapRows` remains stable.
   - Spanning layout dimensions in `updateLayoutFromCache` symmetrically apply `extraCols` and `extraRows`: `cols: layout.cols + extraCols`, `rows: layout.rows + extraRows`.

## Spanning Grid Representation in Folder Card Views (`cellsTooSmall`)

Wherever folder cards appear in the current view (root overview or drill-down with collapsed subdirectories), Thumbview supports spanning grid mode:
1. **Heterogeneous Item Spanning**:
   - Folder cards occupy 1 unit tall (`nCells: 1`) to preserve clear visual boundaries and consistent card preview mosaic dimensions.
   - Individual files expand proportionally to their line counts (`nCells = cellsNeeded(f.lineCount)`), allowing long files (e.g. 1,000+ lines) to span multiple cells tall (`localCellH * nCells`).
2. **Unified 2D Spanning Drag & Drop**:
   - When in spanning grid mode in folder card view, drag-and-drop operations utilize `reorderSpanningItemsLocal` with 2D coordinate stability. Dragging multi-cell files or folder cards swaps or places items in target slots without reflowing or losing 2D grid alignments.
   - State is persisted via `thumbview.cardOrder`, `thumbview.cardWrapRows`, `thumbview.folderCardOrders`, and `thumbview.folderCardWrapRows`.
3. **Multi-Tile Spanning Swap with Relative Gap Preservation**:
   - When a multi-cell tile (e.g. 5 cells tall) swaps into a column overlapping multiple smaller tiles and empty spaces (e.g. `[1; 0; 1; 1; 0]`), all items overlapping the incoming target span $[finalTargetRow \dots finalTargetRow + sourceCells - 1]$ are collected.
   - Displaced items are placed into the source column using their exact relative row offsets $\Delta r = item.row - finalTargetRow$, preserving the gaps and orientation relative to one another (e.g. `[1; 0; 1; 1; 0]`) rather than collapsing into `[1; 1; 1; 0; 0]`.

## Instantaneous Drag-and-Drop Interaction Architecture

File and folder drag-and-drop operations must feel completely instantaneous with zero perceptible latency.
1. **Low-Latency Pickup Initiation**: `DRAG_THRESHOLD` is set to 3px. When crossed, the webview immediately builds the cached background canvas, calculates drag targets, and renders synchronously on the pickup frame rather than waiting for an asynchronous animation frame request.
2. **Fast-Path Drag Move Routing**: At the very top of the `canvas` `mousemove` listener, active dragging (`draggingFile || draggingFolder`) immediately updates cursor position and schedules a requestAnimationFrame redraw, completely bypassing $O(N)$ hit-testing (`findFileAt`), window focus checks, and tooltip evaluations.
3. **Optimistic Synchronous Reordering & Immediate `slotOccupancy` Updates**:
   - On `mouseup`, if a tile is dropped back onto its starting slot, the gesture is instantly dismissed without sending unnecessary IPC messages to the extension host.
   - When dropped into a new slot, the webview synchronously updates `srcFile.slot`, `srcFile.slots`, `tgtFile.slot`, `tgtFile.slots`, `slotOccupancy`, and local order arrays before rendering immediately. Synchronously updating `slotOccupancy` ensures subsequent mouse events and rapid-succession swaps hit-test against up-to-date file coordinates.
   - Affected file positions are recorded in `userReorderedFileSlots`.
4. **Elimination of Host Roundtrip Lag and Revert Glitch**:
   - On `reorderFile` and `swapCardItems`, `src/extension.ts` directly updates `workspaceState` and `fileOrder` without invoking `updateLayoutFromCache`. This eliminates expensive git diff rescans, diagnostic indexing, and multi-megabyte IPC `data` serialization on every drop.
   - When external `command: "data"` messages arrive (e.g. on file save), `applyDataMessage` checks `userReorderedFileSlots` and preserves user-reordered file positions, preventing race conditions where rapid successive swaps would revert the canvas to an earlier state before re-swapping ~2 seconds later.
5. **Deferred IPC Data Synchronization**: Full extension host `data` broadcast processing in the webview is deferred while dragging is active (`pendingDataMsg`), preventing in-flight host payloads from interrupting user drag gestures or causing visual stutter.

## Scoped Layer Grid Space Architecture (`thumbview.folderExtraCols` & `thumbview.folderExtraRows`)

Expanding and reducing grid space is strictly scoped to the active layer (the root overview or a specific folder drill-down).
1. **Per-Layer Space State Isolation**:
   - `thumbview.extraCols` and `thumbview.extraRows` (or `folderExtraCols[""]` / `folderExtraRows[""]`) track extra dimensions for the root directory.
   - `thumbview.folderExtraCols[folderPath]` and `thumbview.folderExtraRows[folderPath]` track extra dimensions for individual folders (e.g. `"src/"`).
2. **Layer Switching & Space Restoration**:
   - When the user is in the root directory, files fill available canvas space as much as possible with 0 extra empty rows/cols unless root was explicitly expanded.
   - When expanding space inside `"src/"`, `folderExtraCols["src/"]` and `folderExtraRows["src/"]` are incremented without modifying root state or other folders.
   - Navigating back to root restores root's default unexpanded layout. Navigating into `"src/"` restores its expanded empty row and column, allowing tiles to be dropped into those empty slots.
   - Folder thumbnail card previews in overview isolate previews by reading `group.path`'s dimensions, preventing root expansions from affecting subfolder cards and vice-versa.

## Leaf Folder Mode & Subfolder Card False-Positive Prevention

Leaf folders (directories that contain only files, with zero child subdirectories) cannot collapse into subfolder cards mode.
1. **Strict `hasSubfolders` Guard**: In `overview.js`, `cellsTooSmall` requires `hasSubfolders = subfolderInfo.folders && subfolderInfo.folders.length > 0`. Even when canvas width or height shrinks below minimum cell thresholds, a folder with 0 child subdirectories strictly remains in directory drill-down mode (`shouldOpenFolder`), rendering all files individually with `localSpanningLayout`.
2. **State & Reorder Isolation**: Leaf folder drags route strictly through `reorderFile` and `thumbview.folderOrders`, eliminating the bug where leaf folders were treated as folder cards, dispatching `swapCardItems` to `folderCardOrders` and scrambling files.
3. **Grid Capacity Stability**: In folder card mode, `totalItems` is strictly clamped to `orderedItems.length`, preventing empty slot holes in `displayItems` from inflating the grid capacity or triggering unwanted grid expansion when cards/tiles are moved to empty slots.

## Known limitations / accepted tradeoffs

- **Unit test suite**: Core logic is covered by automated unit tests in `src/test/` run via `npm run test:unit`. End-to-end webview testing relies on VS Code Extension Host integration.
- **`MiniLine.category`** (`scanner.ts`) is computed host-side but not read by the webview, which does its own independent tokenization. Left unresolved as either dead code or an unfinished feature — see the comment at its definition.
- **No shared type definitions for the `postMessage` protocol** between `extension.ts` and `media/overview.js` (see CLAUDE.md's "Cross-module interface" note) — protocol drift is caught only by manual review/testing, not the compiler.
