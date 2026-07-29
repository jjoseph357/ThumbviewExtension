# Thumbview

A VS Code extension that visualizes your workspace files as a stable, syntax-highlighted code minimap grid.

## Features

- **Code Minimap Grid**: Automatically renders code files in a 2D layout grid (Uniform or Spanning mode).
- **Interactive Syntax Highlighting**: Multi-colored tokenizer mirrors VS Code theme elements.
- **Immediate Search**: Type directly to search text, paths, and tokens globally across the project.
- **Explorer Context Menu**: Right-click any minimap card to access standard VS Code Explorer commands (Open, Open to Side, Open Preview, Compare, Reveal in Explorer, Open Containing Folder, Cut/Copy/Paste, Rename, Delete, Ignore).
- **Sidebar Tree Views**:
  - **Directory Navigation**: Browse workspace folders with cumulative file counts, single-click folder isolation, right-click folder deletion, and Reveal in Explorer.
  - **Ignored Files & Directories**: View, add (`+`), remove (`trash`), multi-select, delete from disk, and reveal ignored files/folders in Explorer.
- **.gitignore & Negation Support**: Respects `.gitignore` rules including negation patterns (`!pattern`).
- **Tab & Window Management**: Click `×` or middle-click open file cards to close tabs. Jump to lines in pinned tabs.
- **Magnifying Floating Tooltip**: Hold `Left CTRL` (or `CTRL`) while hovering over any minimap card to preview full-sized code blocks with surrounding context lines.

## Keyboard & Mouse Shortcuts

- **`F4`**: Open or focus the Thumbview visual workspace.
- **`Left CTRL` + Mouse Hover**: Hold `Left CTRL` while hovering over a file card to reveal the code magnifying preview tooltip.
- **Left Click Tile**: Jump directly to that line in the document editor tab.
- **Middle Click (or `×` button)**: Close open document or media tab.
- **Left Click Header Bar**: Isolate and focus on that parent folder.
- **Right Click Card**: Open Explorer context menu.
- **`⚙ Actions & Shortcuts` Button**: Toggle the interactive overlay panel in the top-right corner.
