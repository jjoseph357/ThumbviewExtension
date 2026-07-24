# Change Log

All notable changes to the "thumbview" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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