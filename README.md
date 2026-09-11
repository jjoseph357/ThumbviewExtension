# Thumbview

> Because life's too short to thumb-wrestle with the VS Code sidebar.

A 2D, syntax-highlighted minimap grid of your entire workspace. See every file at once, search across all of them, and jump to any line in one click.

## Setup

1. Install the extension and open a workspace folder.
2. Press `F4`, or run `Thumbview: Open` from the Command Palette, to open the grid. Thumbview scans your workspace automatically with zero configuration.
3. Optional: open the **Thumbview** container in the Activity Bar to access navigation and settings panels.

Change settings via **File > Preferences > Settings > Thumbview** (see [Settings reference](#settings-reference)).

## Core workflow

- **Open the grid.** Press `F4` to open or refocus the tab.
- **Jump to a line.** Click any line on a tile to open the file at that position.
- **Visual recognition.** Tiles display syntax-highlighted minimaps. A colored strip at the top shows the file path.
- **Magnify.** Hold `Left CTRL` and hover over a tile to preview readable code lines without opening the file.
- **Search across all files.** Type in the top search bar to highlight matches across all tiles. Clear the box or press `×` to reset. Use `Alt+C`, `Alt+W`, or `Alt+X` to toggle match case, whole word, or regex.
- **Close open editors.** Middle-click a tile or click its `×` icon.

## Reading the grid

- **Layout modes.** Spanning grid (default) gives tall files multiple vertical cells so file length is visible at a glance. Uniform grid assigns one equal cell per file. Switch modes from the settings modal, sidebar, or Command Palette.
- **Folder cards.** When tiles shrink below the minimum size (60×40 px by default), files group into clickable folder cards with mini-mosaic previews. Click a card to drill down into that folder, and use top breadcrumbs or mouse buttons 3 and 4 to navigate back.
- **Folders and ignored patterns.** Click **Folders & Ignored** in the toolbar to inspect active folders, isolate subdirectories, view ignored globs, and toggle patterns.
- **Resize stability and reflow.** Resizing the window or sidebar scales tiles without reflowing files across columns. To pack empty spaces and remove gaps after moving files, run `Thumbview: Reflow Layout` or click **Reflow Grid** in settings.

## Ignoring and unignoring files

Hide build output, vendor directories, and generated files to keep the grid clear:

- **Toolbar controls.** Click **Folders & Ignored** in the top toolbar to view active patterns, add new globs, or remove patterns.
- **Ignore directories.** Right-click a folder in **Directory Navigation** and select **Ignore Directory**, or click its hide icon.
- **Ignore individual files.** Right-click any tile and select **Ignore in Thumbview**.
- **Unignore items.** Click the eye icon next to hidden folders in **Directory Navigation**, or remove the pattern from the **Folders & Ignored** list.
- **Auto-ignore threshold.** Folders with more files than `thumbview.autoIgnoreThreshold` (default 30) hide automatically. Set to `0` to disable. Unhiding an auto-ignored folder saves an exclusion so it stays visible.
- Patterns save to workspace state, keeping rules isolated per repository.

## Additional features

- **Drag and drop reordering.** Drag tiles to swap positions, shift adjacent files, or place files into empty slots. Configure the default action with `thumbview.dragReorderMode` (`swap` or `shift`).
- **Folder isolation.** Click a folder in the toolbar popover or a tile header to dim other files. Click the root breadcrumb to restore the full view.
- **Root files focus.** Choose **Root Directory Files Only** in the popover to spotlight top-level files like package manifests and configuration files.
- **File operations.** Right-click any tile to open, split, compare, rename, reveal in explorer, or delete, without switching to the file explorer.

## Shortcuts reference

| Action | Shortcut |
| :--- | :--- |
| **Open / Focus Thumbview** | `F4` |
| **Code Magnifier** | Hold `Left CTRL` + Hover |
| **Jump to Line** | Left-click a line on a tile |
| **Drag to Reorder** | Click & drag tile to slot |
| **Close Tile Tab** | Middle-click or `×` button |
| **Isolate Folder** | Left-click folder or tile header strip |
| **Context Menu** | Right-click a tile |
| **Navigate History** | Mouse Button 3 (Back) / 4 (Forward) |

Shortcuts and layout toggles are also accessible from the settings modal in the top-right corner.

## Settings reference

| Setting | Default | Description |
| :--- | :--- | :--- |
| `thumbview.layoutMode` | `spanning_grid` | `spanning_grid`: tall files span vertical cells. `uniform_grid`: one equal cell per file. |
| `thumbview.dragReorderMode` | `swap` | `swap`: swap positions with target slot. `shift`: shift adjacent tiles. |
| `thumbview.autoIgnoreThreshold` | `30` | Auto-ignore subfolders with more than this many files (`0` disables). |
| `thumbview.renderMediaThumbnails` | `true` | Render image and PDF thumbnails inside tiles. |
| `thumbview.compressionPercentage` | `5` | Compression threshold: when code shrinks to this percentage of its height in a cell, the tile expands one cell taller (0% disables, 1% to 20% recommended, max 25%). |
| `thumbview.minCellWidth` | `60` | Minimum tile width (px) before files group into folder cards. |
| `thumbview.minCellHeight` | `40` | Minimum tile height (px) before files group into folder cards. |

