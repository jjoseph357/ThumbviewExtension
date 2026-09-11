# Change Log

All notable changes to the "thumbview" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] - 2026-09-09

### Added
- Mouse buttons 3 and 4 support to step backward and forward through folder drill-down history.
- Expandable directory tree and file counts in the ignored patterns popover.

### Changed
- Grid space expansion and reduction now scale rows and columns like a camera zoom. Existing tiles shrink toward the top left while new rows and columns appear on the bottom and right, preserving relative positions without reflow.
- Grid expansion is scoped per folder, so adding space inside a subdirectory leaves the root view untouched.
- Folder card previews mirror the drill-down view, including line-height spanning tiles and nested subfolder cards.

### Fixed
- Folder view aspect ratio and right-side void after reflow.
- Grid row height freeze when expanding space inside a reflowed folder view.
- Rapid successive drag swaps by updating slot occupancy in memory immediately upon drop.
- Multi-cell tile swaps collapsing empty gaps and shifting unrelated files.
- False folder card grouping in leaf folders with no subdirectories.
- Canvas expansion when dragging tiles into bottom empty rows or far-right columns.
- Window and sidebar resizing reflowing tiles across columns.

## [0.4.5] - 2026-08-31

### Added
- **Diagnostic Error Title and Overview Highlighting**: File titles turn red (`--vscode-list-errorForeground`) when syntax or type errors exist in the file, matching VS Code's file explorer behavior. Offending lines render red background and gutter highlights on the overview thumbnail tile, with diagnostic messages and error badges in the Left CTRL inspect tooltip.
- **Git Deletion Gutter Carets & Diff Indicators**: Rendered Git deletions as red gutter triangle carets (`▶`) on minimap tiles instead of full-width stripes, reserving full-width row fills for active lines. In the Ctrl-magnifier inspect tooltip, deleted lines feature strikethrough text with `-` diff prefixes, while errors display `✕` indicators and diagnostic messages.

### Changed
- **Recency Viewport Band Transparency**: Adjusted the gray editor viewport range overlay (`viewportBandOverlay`) opacity from `0.22` to `0.08` so blue modified highlights and green added highlights remain clear and distinct.

## [0.4.4] - 2026-08-29

### Changed
- **Git Status File Title Color Coding**: File titles are now styled directly in Yellow (modified) and Green (added / untracked) according to your VS Code theme's Git decoration colors, replacing the M and U/A badge glyphs for cleaner card headers.
- **Drag and Drop Map Optimizations**: Replaced $O(N)$ linear scans on mouse hover and dragging with $O(1)$ spatial coordinate Map lookups (`slotOccupancy`), indexed placements into Maps in the extension host, and eliminated frame allocations in `render()`.

### Fixed
- **Spanning Grid Bottom Row Drag Placement**: Fixed an issue where dragging tiles to lower or bottom rows failed to persist the expanded row capacity, which previously caused items to wrap into adjacent columns and expand canvas dimensions.
- **Cross-Column 1-Tall Tile Swapping**: Fixed an issue where swapping two 1-tall files at different row coordinates across columns swept up adjacent row 0 tiles and displaced them to the right. Equal-span tiles now swap exact slot positions cleanly.

## [0.4.3] - 2026-08-29

### Added
- **Unified Folders & Ignored Side-by-Side Modal**: Combined the separate Folders and Ignored top toolbar buttons into a single Folders & Ignored button opening a two-column glassmorphic modal. The left column lists active folders shown in Thumbview with file counts, click-to-isolate actions, and single-click ignore buttons. The right column lists all ignored folders and glob patterns with folder icons, an inline pattern input with an Add button, and one-click unignore buttons.
- **Automated Spanning Reordering Test Suite**: Added a unit test suite in `src/test/spanning_reorder.test.ts` and `npm run test:unit` verifying intra-column, cross-column, multi-tile displacement, and empty-slot movements.

### Fixed
- **Spanning Grid Aspect-Ratio Scaling**: Grid dimensions now expand proportionally in both horizontal and vertical directions when adding space, maintaining natural code aspect ratios without shifting existing tiles.
- **Symmetric Multi-Tile Cross-Column Drag and Drop**: Reordering spanning tiles across columns now collects and swaps all overlapping files across the full vertical span, preventing tile overwrites, lost files, or unintended canvas reflows.
- **Self-Drop and Intra-Column Movement Protection**: Resolved tile duplication when dragging a multi-cell file down onto its own sub-cells or swapping files within the same column.
- **Title Click Drag-State Reset**: Fixed an issue where clicking a file tile's title or header left candidate drag state active, causing subsequent mouse movement to trigger accidental file dragging.
- **Spanning Grid Drag Teleportation with Tall Files**: Fixed an issue where dragging files to empty slots on lower rows in workspaces with tall spanning files caused tiles to drop off the 2D grid matrix and teleport to the first empty slot. `buildSpanningGrid` and `reorderFile` now dynamically accommodate all spanning file cell heights and targeted row coordinates.
- **Opaque Blue Viewport Band on Windows**: Restored the open file editor viewport range overlay (`viewportBandOverlay`) to transparent gray (`rgba(255, 255, 255, 0.22)`), preventing solid opaque theme colors (`--vscode-editor-selectionBackground`) from covering code lines.
- **Search Bar Input Hijacking**: Fixed the global `keydown` event listener in `media/overview.js` to ignore keystrokes when any text input, textarea, or select element is focused, allowing users to type glob patterns into the ignore input without keystrokes being redirected to the search bar.
- **Consistent Ignored Folder Representation**: Automatically and manually ignored folders now consistently display folder items and badges in both the webview modal and sidebar tree views.

## [0.4.2] - 2026-08-07

### Added
- **Top Toolbar Navigation & Controls**: Added top toolbar controls with directory navigator, pattern manager, and interactive `⚙ Settings` modal directly on the webview toolbar. Allows switching layout modes (Spanning vs Uniform Grid), drag-to-reorder modes (Swap vs Shift), media thumbnails toggle, layout reflow, and full folder/ignore management.
- **Drag-and-Drop Tile Reordering**: Click-drag any file tile onto another to reorder the grid. Two modes, Swap and Shift, toggle via the Command Palette, settings modal, or sidebar links. Swap trades tile positions, while Shift inserts at the target and shifts items between. Works in both Uniform and Spanning grid layouts, persists across rescans and reloads, and shows a live ghost of the dragged tile plus an outline on the current drop target while dragging.
- **Empty Grid-Slot Drag Placement**: Users can drop file tiles into empty slots across both Uniform and Spanning grid modes. Dropping a tile to an empty space leaves an empty space where it came from so surrounding files do not reflow.
- **Git Status & Diff Tracking**: Visual gutter markers and status badges for modified, added, untracked, and deleted files with real-time Git repository change detection.
- **Theme Color Centralization & Fixed Brand Accents**: All webview HTML/CSS and canvas UI chrome colors now derive dynamically from the user's active VS Code theme (`--vscode-*`), automatically adapting across Dark+, Light+, and High Contrast themes. Three fixed brand accents are defined in `src/colors.ts`: search highlight (`#dc267f`), magnifier inspection (`#785ef0`), and open-tab recency (`#fe6100`).
- **General Hover Outline**: Hovering any tile now outlines it in the same accent color as the drag ghost/drop-target outline, for a consistent "you're interacting with this tile" affordance.

### Fixed
- **Stale WorkspaceState Keys for Spanning Layout**: Fixed stale `repomap.spanningAllocations` and `repomap.spanningRows` reads in `extension.ts` so persisted spanning allocations and row calculations reliably load from `thumbview.*`.
- **Sidebar Remaining Visible in Zen Mode**: Removed the automatic sidebar un-hiding in `enterFullscreen()`, ensuring the left sidebar stays hidden during Zen mode for a true full-canvas view.
- **Split Code Editors Visible to the Right in Zen Mode**: Enforced `zenMode.singleTabGroup: true` in `forceZenSettings()`, ensuring split editor groups to the right are hidden on enter and restored on exit.
- **Active-File Border Never Showing**: The active-file border now tracks the last editor that had focus before opening Thumbview, fixing an issue where the open-file border never appeared while Thumbview was focused.

## [0.4.1] - 2026-08-07

### Added
- **README Catchphrases**: Added a couple fun catchphrases to the README.md to help explain the value proposition.

### Fixed
- **Line Numbers Disappearing**: Forced `zenMode.hideLineNumbers` to `false` during Thumbview to prevent VS Code from hiding them in editor windows upon exiting zen mode.
- **Tab Dragging Splitting Guard**: Added layout protection that automatically closes Thumbview if its tab is dragged into a new split while in fullscreen mode, preventing the zen mode layout from breaking.
- **Manual Zen Mode Inversion**: Added tree-view visibility detection to ensure Thumbview doesn't accidentally exit an existing manual zen mode session when initialized.
- **Zen Mode Layout Inversion and Visible Tabs**: Removed a buggy visibility check that incorrectly inverted manual zen mode sessions and sometimes caused tabs to remain visible when opening Thumbview.

## [0.4.0] - 2026-08-07

### Changed
- **Always-Fullscreen Thumbview via Zen Mode**: Opening Thumbview now takes over the workbench through Zen Mode, hiding sidebars, panel, and auxiliary bar while maximizing editor groups. Prior layout state is restored on exit. `zenMode.centerLayout` and `zenMode.fullScreen` are temporarily forced off so the grid uses the full window, with original values backed up to workspaceState and restored on exit or next activation after a crash.

### Fixed
- **Slow, Multi-Step Fullscreen Transitions**: Zen Mode and editor-group maximize run concurrently so the panel renders at full size immediately, and opening a file from the grid overlaps layout exit with file disk reads.
- **Fullscreen Only Working Every Fourth Toggle / Phantom Split Groups**: All layout operations are now serialized through a promise queue with synchronously-set state flags. Previously, concurrent `enterFullscreen()` calls from the command path and `onDidChangeViewState` both passed the `fullscreenActive` check before either set it, stacking blind `toggleMaximizeEditorGroup` calls that cancelled each other or left splits stuck hidden.
- **Stray Split Groups When Opening Files from the Grid**: `jump` and `switchTab` now exit fullscreen before opening the document, so editors never open into a maximized group and force VS Code to spawn a side group that didn't exist before.
- **Split Widths Drifting Every Toggle**: `toggleMaximizeEditorGroup` acts on the active editor group, but it was fired at moments when different groups were active (maximize on the code group before `reveal()`, unmaximize on Thumbview's group), skewing split widths each cycle instead of restoring them. Maximize now runs only after the Thumbview panel is active (`maximizeThumbviewGroup()`), and unmaximize re-reveals the panel first if needed, so both toggles always land on Thumbview's group.
- **Zen Mode Inverted (Code in Zen, Thumbview Not)**: The view-state handler now exits fullscreen only when the panel is actually hidden (`visible === false`), ignoring view-state events while a layout operation is in flight to prevent queued exit calls from inverting Zen Mode.

## [0.3.9] - 2026-08-06

### Added
- **Match Case, Match Whole Word, and Regex Search**: Added Match Case (`Aa`), Match Whole Word (`ab`), and Use Regular Expression (`.*`) search toggles, with `Alt+C`, `Alt+W`, and `Alt+X` keyboard shortcuts. `media/overview.js`'s `rebuildSearchState()`/`textMatches()` are now the single matching engine behind grid tile borders/dimming, the per-line minimap match highlight, and the hover tooltip's highlighted matches. An invalid regex shows a red outline on the search input and stops dimming the grid instead of treating every tile as non-matching.

### Fixed
- **Post-Jump Line Flash Respects Search Options**: Opening a file by clicking a minimap tile now flashes matching lines in the editor using the same Match Case/Whole Word/Regex options active in the grid, instead of always doing a plain case-insensitive substring match.
- **Search Option Buttons Swallowing Their First Click**: Search toggle buttons now suppress default focus shifts on `mousedown` so clicks register on the first press.

## [0.3.8] - 2026-08-06

### Changed
- **In-Memory Cache Layout Updates**: Updated `src/extension.ts` to cache scanned files (`cachedScannedFiles`) upon repository scan and re-filter active files via `updateLayoutFromCache()` during ignore/unignore state changes or layout mode switches. This avoids redundant disk re-scans when toggling ignore rules.
- **Preserved Webview Image & View State**: Prevented webview data resets (`clearData: false`) and preserved webview image caches during layout updates to avoid unnecessary UI flashes and image re-fetching.

## [0.3.7] - 2026-08-05

### Fixed
- **Root Directory Files Only Ignore Support**: Updated `scanner.ts` `shouldIgnore()` to handle the `(root files)/` ignore pattern, filtering out top-level workspace root files (files without slashes in their relative paths). Updated `directoryProvider.ts` to evaluate `isFolderIgnored("(root files)/", ignorePatterns)` and count total root files from `allFiles` for the "Root Directory Files Only" tree item so it preserves total file counts and displays `(hidden)` state formatting, closed-eye icon, and context actions when hidden.

## [0.3.6] - 2026-08-04

### Fixed
- **Prevent Text Editor Unfocusing & Focus Stealing**: Removed automated `window.focus()` invocations from `openState` and `data` webview message handlers in `media/overview.js`. This prevents Thumbview from shifting focus away from active text editors during document modifications, cursor/line movements, or background file updates.

## [0.3.5] - 2026-08-04

### Fixed
- **Instant Image Thumbnail Refresh**: `media/overview.js` now clears `imageCache` on repository data updates and appends a cache-busting timestamp parameter (`?v=timestamp`) when instantiating `Image` elements, ensuring modified image and PDF files on disk refresh immediately in minimap tiles without requiring closing and reopening Thumbview.

### Changed
- **Documentation Cleanup**: Removed image tags from `README.md` for clean Marketplace rendering without broken image icons, updated section headings to "More Features" across `README.md` and `⚙ Actions & Shortcuts` webview modal.

## [0.3.4] - 2026-08-04

### Added
- **Fixed Magnifying Overlay Width Per File**: The code magnifying hover overlay (`#hover-tooltip`) width is now calculated once per file based on `min(max width allowed, widest line)`, preventing overlay window size jitter while moving across lines in the same file.
- **Comprehensive Project Setup & Ignore Guides**: Rewrote `README.md` and updated the `⚙ Actions & Shortcuts` webview modal overlay with detailed instructions on environment setup, layout modes (`spanning_grid` vs `uniform_grid`), auto-ignore threshold behavior, step-by-step ignore/unignore workflows (including managing `thumbview.autoIgnoreExclusions`), power-user minimap navigation tips, and embedded screenshot figures.

## [0.3.3] - 2026-08-04

### Added
- **Root Directory Files Only Highlight**: Added a "Root Directory Files Only" item to Directory Navigation sidebar. Selecting it highlights only files located directly in the root workspace folder while dimming subdirectories. Clicking a root file's header bar in the minimap webview also isolates root files.

### Changed
- **Directory-Grouped File Sorting**: Updated file layout sorting algorithm to group root directory files together contiguously at the start of the grid on initialization and reflow, keeping all root files adjacent to each other rather than scattered between subdirectories.

## [0.3.2] - 2026-08-01

### Changed
- **Default Minimum Cell Dimensions**: Adjusted default minimum cell dimensions (`thumbview.minCellWidth` and `thumbview.minCellHeight`) to 32×28 px.

## [0.3.1] - 2026-07-31

### Added
- **Configurable Minimum Cell Dimensions**: Added `thumbview.minCellWidth` (default `32`) and `thumbview.minCellHeight` (default `28`) configuration settings to customize the minimum tile size threshold before files are grouped into subfolder cards.

### Changed
- **Instant Hotkey Toggle & Tab Switch**: Replaced WebviewPanel destruction (`dispose()`) and window reflow animations on toggle hotkey (`F4`) with direct active text document switching (`showTextDocument`). Preserved background webview context enables 0ms instant toggling identical to tab clicks.
- **Smart Directory Selection (Lowlight vs. Folder Opening)**: When root file tiles are visible on screen, selecting a directory (from Directory Navigation sidebar or clicking a path) dims non-selected files (opacity 0.15) to preserve full codebase layout context. If tiles have shrunk below minimum cell size thresholds into folder cards, selecting a directory opens and drills down into that folder.

### Fixed
- **Stale Repository Data Flash Prevention**: Added `clearData: true` flag on repository rescan start, preventing webviews from briefly displaying stale minimap tiles from a previous repository or session while a refresh is in progress.
- **Reliable Window Maximization via Idempotent Commands**: Replaced boolean toggle commands with idempotent VS Code layout commands (`workbench.action.minimizeOtherEditors` and `workbench.action.evenEditorWidths`), eliminating state desynchronization and ensuring window expansion works 100% of the time.

## [0.3.0] - 2026-07-30

### Added
- **Subdirectory Selection Lowlighting**: When selecting a subdirectory in Directory Navigation, remaining workspace files stay positioned in their grid slots and are rendered low-lit (dimmed), preserving full codebase layout context while emphasizing the selected folder.
- **Directory Navigation Context Action "Ignore Directory" & Hidden Folder Indicators**: Added "Ignore Directory" to the right-click context menu in Directory Navigation. Ignored/hidden folders remain visible in the hierarchy, formatted with gray deemphasized text, darker deemphasized icons (`eye-closed`), `(hidden)` label, inline hover eye icon to unignore, and right-click "Unignore Directory".
- **Ignored Files & Directories Context Action "Unignore Directory" & "Delete"**: Added "Unignore Directory" to the right-click context menu in Ignored Files & Directories tree view and renamed the disk deletion option to "Delete" for ignored items.
- **Instant 0ms Editor Group Expansion**: Replaced tab snapshot loops with VS Code's instant 0ms `maximizeEditor` / `toggleEditorWidths` command so Thumbview expands to full width without slowing down or disrupting open tab groups.
- **Automatic Webview DOM Focus on Hotkey Open**: Webview automatically receives browser DOM focus (`window.focus()`) as soon as Thumbview opens via hotkey `F4`, allowing holding `Left CTRL` for magnifying overlay or typing to search immediately without clicking the panel first.
- **Toggle & Focus Hotkey (`F4`)**: Pressing the hotkey when Thumbview is focused toggles the panel closed. Pressing the hotkey when Thumbview is open but unfocused (e.g. side panel selected) brings focus to Thumbview.
- **Aspect Ratio Preservation for Images and PDFs**: Applied `drawAspectFit` rendering to image and PDF thumbnails, ensuring media files maintain their native aspect ratio (`object-fit: contain`) with dark letterbox/pillarbox background centering instead of stretching.
- **Auto-Ignore Guidance Toast Notification**: Updated auto-ignore toast notifications to explicitly inform users to check out 'Ignored Files & Directories' in the Thumbview sidebar to unignore folders if desired.

### Changed
- **Default Layout Mode Set to Spanning Grid**: Changed default configuration setting `thumbview.layoutMode` to `"spanning_grid"`, allowing larger/taller code files to span multiple vertical grid cells by default.
- **Directory-Grouped Relative Path Sorting & Reflow Layout Reset**: Sorted workspace files alphabetically by relative path during scanning so files in the same directory/level sit adjacent to each other in the minimap grid. Running "Reflow Layout" resets the grid order strictly to this directory-grouped relative path sequence while closing all layout gaps.
- **Fixed Maximum Line Gap for Short Files**: Capped line spacing step (`stepY`) to a fixed maximum height (6px) so files with few lines retain standard code line height instead of expanding vertical gaps to fill the thumbnail container height.
- **Ignored Tree Item Eye Icon Updates**: Changed the remove action icon in Ignored Files & Directories to an eye (`$(eye)`) and removed the crossed-out eye icon to the left of ignored tree items, replacing it with standard folder/file icons.

## [0.2.9] - 2026-07-29

### Added
- **VS Code Theme Highlighting for Markdown and JSON**: Improved syntax tokenization for `.md` and `.json` files in Thumbview, correctly applying VS Code theme colors (light blue headers and JSON keys, orange strings, green numbers, and dark blue booleans) to minimap canvas tiles and hover tooltips.
- **Reveal in Explorer Option**: Added "Reveal in Explorer" to the right-click context menu for items in both Directory Navigation and Ignored Files & Directories sidebar tree views, allowing quick location of folders or files in VS Code's File Explorer.
- **Delete Option for Ignored Files & Directories**: Added file/folder deletion to the Ignored Files & Directories tree view right-click context menu, supporting single and batch multi-selection deletions from disk (via Trash or Permanent Delete).

### Fixed
- **Sticky Hover Magnifying Overlay on Keyboard Shortcuts**: Fixed an issue where triggering keyboard shortcuts like `Ctrl+J` or losing window focus left the code magnifying hover overlay stuck on screen. Hover overlay now strictly disables whenever `Ctrl` is not actively held down.
- **Instant Minimap Refresh on Document Save**: Added a direct `onDidSaveTextDocument` event listener and reduced the refresh debounce delay from 500ms to 200ms, ensuring minimap cards update instantly upon saving a file in VS Code.

## [0.2.8] - 2026-07-28

### Fixed
- **PDF Click Opens Viewer Instead of Metadata**: Clicking a PDF tile in the thumbview now opens the file with `vscode.open` (delegating to the user's installed PDF viewer extension) instead of `openTextDocument` which showed raw binary metadata.
- **Single-File Layout Filling Viewport**: When most workspace files are gitignored, remaining files now fill the viewport instead of appearing tiny in the top-left corner. The grid dimensions are now computed from the bounding box of actually-occupied cells rather than the full persistent file order (which retained slots for removed/ignored files across sessions).

## [0.2.7] - 2026-07-28

### Added
- **Directory Navigation Delete Command**: Right-click any folder in the sidebar Directory Navigation tree to delete it (Move to Trash or Delete Permanently), with a confirmation dialog. Root item is excluded from deletion.
- **Directory Navigation Sync on File System Changes**: The sidebar Directory Navigation tree now refreshes automatically when folders or files are created, deleted, or changed in the file explorer, keeping the tree in sync with the workspace.

### Fixed
- **Eliminated `.vscode/settings.json` Repository Pollution**: Moved `ignorePatterns` and `autoIgnoreExclusions` storage from VS Code workspace-folder configuration (`ConfigurationTarget.WorkspaceFolder`, which creates `.vscode/settings.json` in the user's project) to `ExtensionContext.workspaceState` (VS Code's internal per-workspace key-value store). Users will no longer see Thumbview-created files appear in `git status`. Existing `settings.json` values are automatically migrated and cleaned up on first activation.

## [0.2.6] - 2026-07-27

### Fixed
- **Auto-Ignore Re-Add Loop**: Un-ignoring a dense directory no longer causes it to reappear in the ignore list on the next scan. A persistent `thumbview.autoIgnoreExclusions` list tracks user un-ignore decisions so auto-ignore respects them.
- **Cross-Project Ignore Pollution**: All `thumbview.ignorePatterns` reads and writes are now scoped to `ConfigurationTarget.WorkspaceFolder` with explicit workspace folder URI, ensuring ignore patterns from one project never leak into another VS Code window.

### Added
- **Recursive Subfolder Card Expansion**: When the root grid produces cells too small to read (below 60×40px), the view automatically groups files by immediate subfolder and renders clickable folder cards showing folder name, file count, and a density bar. Clicking a card drills into that folder. Recursion continues until tiles are large enough for individual minimap rendering.
- **`thumbview.autoIgnoreExclusions` Setting**: New configuration array that persists directories the user has explicitly un-ignored, preventing auto-ignore from re-adding them.

## [0.2.5] - 2026-07-24

### Fixed
- **Project-Scoped Workspace Ignore Settings**: Updated all `thumbview.ignorePatterns` configuration updates to use `vscode.ConfigurationTarget.WorkspaceFolder` so ignore patterns remain strictly isolated per repository project instead of saving to global user settings.
- **Dynamic Hotkey Label Display**: Restored inline hotkey rendering in sidebar welcome views and modal shortcuts, dynamically resolving keybindings to match user settings.

## [0.2.3] - 2026-07-23

### Added
- **Multi-Select Batch Deletion**: Enabled `canSelectMany: true` on the sidebar `Ignored Files & Directories` tree view, allowing `Shift + Click` or `Ctrl + Click` to select and batch-remove multiple ignore patterns simultaneously.
- **Top-Level Directory Ignore Consolidation**: Automatically aggregates auto-ignored virtualenvs and dense directories to top-level root folders (e.g., `BOFS/`, `.venv/`) to prevent redundant child entries.

### Fixed
- **Redundant Ignored Directory Pruning**: Pruned pre-existing child ignore patterns when a parent directory is already present in `thumbview.ignorePatterns`.

## [0.2.2] - 2026-07-23

### Added
- **Actions & Shortcuts Overlay Panel**: Added an interactive glassmorphic overlay modal triggered via `⚙ Actions & Shortcuts` button displaying keyboard/mouse shortcuts, layout controls, and settings hints.
- **`F4` Shortcut Integration**: Documented and bound `F4` key as the primary shortcut for opening and focusing the Thumbview panel.
- **Auto Window Focus on Mouseover**: Webview canvas automatically requests and restores active panel focus when the cursor enters the Thumbview window.

### Changed
- **`Left CTRL` Hover Modifier Rebind**: Rebound code magnifying preview overlay modifier key from `Alt` to `Left CTRL` to prevent window menu-bar focus stealing.

## [0.2.1] - 2026-07-23

### Performance
- **Parallel Chunked Repository Scanning**: Converted sequential workspace file scanning to parallel batches of 50 via `Promise.all()`, speeding up initial workspace loading by **5x to 7x** (under 500ms).
- **Canvas View Frustum Culling**: Implemented bounding-box viewport culling in the webview canvas loop (`y + fileH < -50 || y > rectH + 50`), skipping offscreen cards and locking canvas rendering at **60 FPS**.
- **Unified `_combinedText` Search Indexing**: Pre-indexed lowercased file strings into a single buffer (`file._combinedText`), replacing multi-line search loops with a fast 1-pass C++ `indexOf` lookup.
- **Pre-Computed Tokenization & HTML Caching**: Syntax tokens and line HTML strings (`line._htmlCache`) are pre-rendered on data receipt, eliminating string allocations during render frames.
- **$O(1)$ Constant-Time Open Tab Checks**: Converted open tab arrays to a `Set<string>` (`openFilesSet`), reducing open border checks from $O(N)$ linear scans to $O(1)$ instant lookups.

### Fixed
- **Media Custom Tab Close & Highlight Support**: Fixed open tab border highlighting (`#f97316`) and middle-click/close `×` button support for Image (`.png`, `.jpg`, `.svg`) and PDF custom editor tabs.

## [0.2.0] - 2026-07-23

### Added
- **Visual Image & PDF Thumbnail Rendering**: Integrated Webview `asWebviewUri` conversion and PDF.js Page 1 offscreen canvas snapshot rendering.
- **Configurable Media Rendering Setting**: Added `thumbview.renderMediaThumbnails` setting (default `true`).
- **Binary File Jumping Fallback**: Handled binary file jumping by catching text document errors and delegating to native `vscode.open`.

## [0.1.3] - 2026-07-22

### Fixed
- **Tab Switching Layout Stability**: Sanitized webview `resize()` and `render()` dimension measurements to ignore transient collapsed tab dimensions (<100px), eliminating tile shrink glitches upon tab switching.
- **Small File Code Line Scaling**: Adjusted font size to 5px for small files ($\le 50$ lines), showing up to 3x more code width on minimap tiles.
- **Top-Left Control Layout**: Anchored search container to top-left and placed folder breadcrumbs dynamically to its right.

## [0.1.0] - 2026-07-22

### Added
- **Initial Release**: 2D Code minimap grid with syntax highlighting, immediate search, Explorer context menu, sidebar tree navigation, `.gitignore` emulation, and dynamic line sampling.