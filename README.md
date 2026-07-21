# Thumbview

A VS Code extension that visualizes your workspace files as a stable, syntax-highlighted code minimap grid.

## Features

- **Code Minimap Grid**: Automatically renders code files in a 2D layout grid.
- **Interactive Syntax Highlighting**: Multi-colored tokenizer mirrors VS Code theme elements.
- **Immediate Search**: Type directly to search text, paths, and tokens globally across the project.
- **Folder Navigation**: Focus on specific subdirectories by double-clicking.
- **Magnifying Floating Tooltip**: Hover over any minimap line to preview the actual code block with line numbers.

## Development

Prerequisites: Node.js and npm.

```bash
npm install        # install dependencies
npm run compile     # one-off TypeScript build -> out/
npm run watch       # incremental build, rebuilds on save
npm run lint        # eslint over src/
```

### Run it inside VS Code (recommended while developing)

1. Open this folder in VS Code.
2. Press `F5` (or Run and Debug → "Run Extension"). This runs the `watch` build task automatically, then launches a new "Extension Development Host" window with Thumbview loaded.
3. In that new window, press `F4` (or run the command **Thumbview: Open**) to open the minimap panel.
4. Edit source files in the original window; the extension host window will pick up rebuilt code the next time you relaunch F5 (a plain save + watch rebuild is not enough — the extension host itself needs restarting).

### Package and install a `.vsix` locally

```bash
npm install -g @vscode/vsce   # one-time, if you don't have vsce
vsce package                   # produces thumbview-<version>.vsix
code --install-extension thumbview-<version>.vsix
```

### Notes

- There is no test suite yet — `npm test` runs `@vscode/test-cli`, but no test files currently exist under this project.
- `node_modules/`, `out/`, and `*.vsix` are gitignored build artifacts; `npm install` and `npm run compile` regenerate them.
