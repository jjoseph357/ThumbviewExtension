# Thumbview

> Because life's too short to thumb-wrestle with the VS Code sidebar.

A 2D, syntax-highlighted minimap grid of your entire VS Code workspace. Keep a thumb on your whole codebase without opening 80 tabs. See every file at once, search across all of them instantly, and jump to any line in one click.

## Setup

1. Install the extension and open any workspace folder.
2. Press `F4` (or run `Thumbview: Open` from the Command Palette) to open the grid. Thumbview scans your workspace automatically and requires zero configuration.
3. Optional: open the **Thumbview** container in the Activity Bar (left edge) to access the **Actions & Settings**, **Directory Navigation**, and **Ignored Files & Directories** panels.

Tune behavior later via **File → Preferences → Settings → Thumbview** (see [Settings Reference](#settings-reference)).

## Core Workflow

- **Open the grid**: `F4`. Press it again any time to refocus the tab.
- **Jump to a line**: left-click any line on any tile and the file opens scrolled exactly there.
- **Identify files by shape**: each tile is a syntax-highlighted minimap of one file, so you recognize code by its visual fingerprint, not by filename. The colored strip at the top of a tile shows its path.
- **Magnify**: hold `Left CTRL` and hover over a tile to preview full-size, readable code lines without opening the file.
- **Search everything at once**: type in the top search bar to highlight tokens across *all visible tiles* instantly. Press `×` or clear the box to reset. Toggle **Match Case** (`Aa`), **Match Whole Word** (`ab`), or **Use Regular Expression** (`.*`) next to the search box — or `Alt+C`/`Alt+W`/`Alt+X` from anywhere in the panel — to refine what counts as a match.
- **Close a tile tab**: middle-click it or click its `×`.

## Reading the Grid

- **Layouts**: `thumbview.layoutMode` selects `"spanning_grid"` (default - tall files span multiple vertical cells, so file length is visible at a glance) or `"uniform_grid"` (one equal cell per file). Switch any time from the top toolbar **⚙ Settings** modal, Command Palette (`Thumbview: Use Uniform/Spanning Grid Layout`), or the sidebar.
- **Folder cards**: when tiles would shrink below the minimum cell size (`thumbview.minCellWidth: 32` / `thumbview.minCellHeight: 28` px), files group into clickable folder cards. Click a card to drill into that subfolder; use the breadcrumbs at the top to navigate back.
- **Directory Navigation**: click the **📁 Folders** button in the top toolbar to focus any subdirectory, isolate root files, or reset to root without leaving the canvas.
- **Reflow**: run `Thumbview: Reflow Layout` or click **Reflow Grid** in the **⚙ Settings** modal to re-fit the grid after resizing the panel or window.

## Ignoring & Unignoring Files

Keep the grid fast and relevant by hiding noise (`dist/`, generated code, vendored assets):

- **Manage ignores from the top bar**: click **👁 Ignored** in the top toolbar to see all active ignore patterns, add custom globs with `+ Add`, or remove patterns instantly with `×`.
- **Ignore a directory**: right-click it in **Directory Navigation** → **Ignore Directory** (or click its inline eye-closed icon).
- **Ignore a file**: right-click its tile in the grid → **Ignore in Thumbview**.
- **Unignore**: click the 👁 icon next to any `(hidden)` folder in **Directory Navigation**, or click `×` in the top **👁 Ignored** popover.
- **Auto-ignore**: any subfolder with more than `thumbview.autoIgnoreThreshold` files (default 30) is hidden automatically to keep rendering fast. Set it to `0` to disable, or unhide individual folders via 👁. Manual unhides are remembered as exclusions.
- Ignores live in workspace state, so each project keeps its own view.

## More Features

- **Isolate a folder**: click a folder in **📁 Folders** popover or a tile's header strip to dim everything else (opacity 0.15). Click **All Workspace Files (Root)** or the breadcrumb root to reset. This is the fastest way to scope search and scanning to one area of the codebase.
- **Root files only**: select **Root Directory Files Only** in the **📁 Folders** popover to spotlight top-level files (`package.json`, `README.md`, configs) for orienting yourself in an unfamiliar repo.
- **Full file operations from the grid**: right-click any tile for Open, Open to the Side, Open Preview, Select for Compare / Compare with Selected, Reveal in Explorer, Open Containing Folder, Cut/Copy/Paste paths, Rename, and Delete — no need to switch to the Explorer.

## Shortcuts Reference

| Action | Shortcut |
| :--- | :--- |
| **Open / Focus Thumbview** | `F4` |
| **Code Magnifier** | Hold `Left CTRL` + Hover |
| **Jump to Line** | Left-click a line on a tile |
| **Close Tile Tab** | Middle-click or `×` button |
| **Isolate Folder** | Left-click folder or tile header strip |
| **Context Menu** | Right-click a tile |

All shortcuts and interactive settings are available in the in-app **⚙ Settings** modal (top-right of the grid).

## Settings Reference

| Setting | Default | Description |
| :--- | :--- | :--- |
| `thumbview.layoutMode` | `spanning_grid` | `spanning_grid`: tall files span vertical cells. `uniform_grid`: one equal cell per file. |
| `thumbview.autoIgnoreThreshold` | `30` | Auto-ignore subfolders with more than this many files (`0` disables). |
| `thumbview.renderMediaThumbnails` | `true` | Render image and PDF thumbnails inside tiles. |
| `thumbview.minCellWidth` | `32` | Minimum tile width (px) before files group into folder cards. |
| `thumbview.minCellHeight` | `28` | Minimum tile height (px) before files group into folder cards. |
