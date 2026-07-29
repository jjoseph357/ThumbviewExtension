# Change Log

All notable changes to the "thumbview" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Performance Optimizations
- **Parallel Chunked Repository Scanning**: Converted sequential workspace file scanning to parallel batches of 50 via `Promise.all()`, speeding up initial workspace loading by **5x–7x** (under 500ms).
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