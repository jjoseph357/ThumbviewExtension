# Thumbview

A VS Code extension that visualizes your workspace files as a stable, syntax-highlighted code minimap grid.

## Features

- **Code Minimap Grid**: Automatically renders code files in a 2D layout grid (Uniform or Spanning mode).
- **Interactive Syntax Highlighting**: Multi-colored tokenizer mirrors VS Code theme elements.
- **Immediate Search**: Type directly to search text, paths, and tokens globally across the project.
- **Explorer Context Menu**: Right-click any minimap card to access standard VS Code Explorer commands (Open, Open to Side, Open Preview, Compare, Reveal in Explorer, Open Containing Folder, Cut/Copy/Paste, Rename, Delete, Ignore).
- **Sidebar Tree Views**:
  - **Directory Navigation**: Browse workspace folders with accurate cumulative file counts and single-click folder isolation.
  - **Ignored Files & Directories**: View, add (`+`), and remove (`trash`) custom ignore patterns.
- **.gitignore & Negation Support**: Respects `.gitignore` rules including negation patterns (`!pattern`).
- **Tab & Window Management**: Click `×` or middle-click open file cards to close tabs. Jump to lines in pinned tabs.
- **Magnifying Floating Tooltip**: Hover over any minimap line to preview full-sized code blocks with surrounding context lines.

## Development

Prerequisites: Node.js and npm.

```bash
npm install          # install dependencies
npm run compile      # regenerate the webview's shared layout block, type-check to out/, bundle to dist/
npm run watch        # esbuild bundle + tsc in watch mode (used by F5); also re-syncs the webview's layout_core block
npm run lint         # eslint over src/
npm run test:unit    # compile, then run the node-based unit tests
npm run sync-core    # copy src/layout_core.ts into media/overview.js after editing it
npm run check-core   # fail if media/overview.js is out of date with src/layout_core.ts
npm run package      # build a .vsix with vsce (README images point at the public thumbview-assets repo)
npm run publish:marketplace   # publish to the Marketplace with the same image base URL
npm run publish-assets       # copy media/screenshots/ into ../thumbview-assets and push it
# Bug reports: public issues-only repo github.com/jjoseph357/thumbview-issues (package.json "bugs")
npm run screenshots  # regenerate the README images in media/screenshots/ (needs Chrome, python3, ffmpeg)
npm run test:a11y    # axe-core accessibility audit of the webview in headless Chrome
npm test             # integration tests in a downloaded VS Code (src/test/integration; Linux CI uses xvfb-run)
npm run benchmark    # webview timings at 1k/5k/10k synthetic files (see DESIGN.md "Scale benchmark")
python3 scripts/generate-demo-workspace.py   # (re)create demo-workspace/ for manual testing
```

### How the build fits together

- **Extension host.** `scripts/build.mjs` bundles `src/extension.ts` and its imports into `dist/extension.js` with esbuild. That bundle is what `package.json` `main` loads and the only host code that ships. `tsc` still compiles `src/` to `out/` for type checking and because several unit tests load `out/*.js`.
- **Webview.** `media/overview.js` is loaded as a plain script, not bundled. The layout functions it shares with the host (`buildStableGrid`, `cellsNeeded`, `fillLayoutHoles`, and the spanning drag reorders) live once in `src/layout_core.ts` and are generated into a marked block at the top of `overview.js` by `npm run sync-core` (also run by `npm run compile`). Never edit that block by hand; CI fails if it is stale.

### Run it inside VS Code (recommended while developing)

1. Open this folder in VS Code.
2. Press `F5` (or Run and Debug → "Run Extension"). This runs the `watch` build task automatically, then launches a new "Extension Development Host" window with Thumbview loaded.
3. In that new window, press `F4` (or run the command **Thumbview: Open**) to open the minimap panel.
4. Edit source files in the original window; the extension host window will pick up rebuilt code the next time you relaunch F5 (a plain save + watch rebuild is not enough — the extension host itself needs restarting).

### Package and install a `.vsix` locally

```bash
npm run package                                    # produces thumbview-<version>.vsix
code --install-extension thumbview-<version>.vsix
```

The package contains only `dist/extension.js`, the runtime files in `media/`, and the README, CHANGELOG, and LICENSE (see `.vscodeignore`).

### Notes

- The unit tests live in `src/test/` and run under plain Node (`npm run test:unit`). Webview tests load `media/overview.js` against mock DOM objects (`src/test/helpers/overview_harness.js`); host modules are loaded from `out/` or transpiled in memory (`src/test/helpers/load_ts.js`). `bundle_smoke.test.js` loads the shipped `dist/extension.js` itself.
- The integration step sets `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`, caches `.vscode-test/`, and retries once, because the VS Code download timed out on runners with slow IPv6.
- GitHub Actions (`.github/workflows/ci.yml`) runs `check-core`, lint, the unit tests, the accessibility audit, the integration tests, the benchmark, and `vsce package` on Linux for every push, and the unit tests on Windows and macOS for pull requests and `main` (those runners cost more minutes on a private repository).
- `media/generate_icons.py` renders the icons from SVG and needs `cairosvg`: `python3 -m venv venv && venv/bin/pip install cairosvg && venv/bin/python media/generate_icons.py`.
- `.gitattributes` forces LF line endings (tests slice `media/overview.js` with `\n`-anchored patterns, which would break on a Windows CRLF checkout).
- `demo-workspace/` is gitignored; `scripts/generate-demo-workspace.py` is the tracked source of its content and also feeds the headless scripts and integration tests.
- `node_modules/`, `out/`, `dist/`, and `*.vsix` are gitignored build artifacts; `npm install` and `npm run compile` regenerate them.
