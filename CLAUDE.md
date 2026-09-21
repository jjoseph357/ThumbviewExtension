# Guidance for Claude Code

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. See [DESIGN.md](DESIGN.md) for the design rationale behind the architecture and behavior decisions described here.

## Keeping documentation current

Every change must update all affected documentation before the task is complete. Stale documentation is actively harmful.

- **CLAUDE.md.** Update when architecture, module responsibilities, config keys, or conventions change.
- **DESIGN.md.** Update when a design decision changes. Explain the technical reasons behind architecture decisions so maintainers understand tradeoffs.
- **CHANGELOG.md.** Update for every release following Keep a Changelog guidelines.
- **README.md.** Update when commands, features, or the development workflow change.
- **CODEBASE_OVERVIEW.md.** This is a dated audit snapshot marked "re-verify before relying on specifics", not living documentation. Do not update it for routine changes. Touch it only if a change falsifies one of its specific claims, and prefer noting the document as stale over rewriting it wholesale.
- **In-code comments.** Update file-level and inline comments when the behavior or structure they describe changes.

## Code comments

Follow the global no-comments-by-default rule (comment the WHY, never the WHAT). On top of that, follow these project conventions:

- **Top-of-file summary.** Add 1 to 2 lines on the pure-logic modules (`scanner.ts`, `layout.ts`, `spanning_layout.ts`, `state.ts`) and on `media/overview.js` explaining what the module computes and what it returns to its caller. `extension.ts` does not need one because its command registrations are self-orienting.
- **MARK-style section comments.** Used in `media/overview.js` on the top-level render and event-handler blocks (`render()`, `mousedown`, `mousemove`, `mouseup`) for navigation. Do not introduce them elsewhere unprompted.
- **Duplicated logic.** Anything that exists in two places (`buildStableGrid`, the tokenizers) needs a one-line comment at each copy pointing at its twin, so edits do not leave the other copy stale.

## Commands

```bash
npm install          # install dependencies
npm run compile      # one-off TypeScript build: src/ -> out/
npm run watch        # incremental build, rebuilds on save (tsc -watch)
npm run lint         # eslint over src/
npm run test:unit    # run the node-based unit test suite
```

### Running the extension while developing

Pressing `F5` starts the `watch` build task and launches an Extension Development Host window with Thumbview loaded. Pressing `F4` in that window opens the minimap panel. It does not hot-reload. Relaunch `F5` to pick up compiled changes. A full walkthrough is in README.md.

### Packaging

Packaging is situational, not everyday development. See README.md's "Package and install a `.vsix` locally" section for the `vsce package` steps.

## Architecture

Thumbview is a VS Code extension that renders every workspace source file as a syntax-highlighted minimap tile in a grid. Two runtime halves communicate over `webview.postMessage`: the extension host (Node, TypeScript, compiled to `out/`) and the webview (browser JS, `media/overview.js`, unbundled).

```
extension.ts (host)
  ├─ scanRepository()        [scanner.ts]         walks workspace in parallel batches of 50 (Promise.all), receives ignorePatterns/autoIgnoreExclusions
  │                                                from workspaceState, consolidates top-level root ignores (such as BOFS/), enforces safety caps
  │                                                (max 2MB per file, max 2000 lines sampled evenly spaced, max 300 chars per line),
  │                                                and respects autoIgnoreExclusions.
  ├─ buildStableGrid()       [layout.ts]          uniform_grid mode: maps item count to near-16:9 grid slots.
  ├─ buildSpanningGrid()     [spanning_layout.ts] spanning_grid mode: tall files occupy multiple cells.
  ├─ PersistentFileOrder     [state.ts]           keeps file-to-grid-slot assignment stable across rescans.
  ├─ IgnoreTreeDataProvider  [ignoreProvider.ts]  drives sidebar 'Ignored Files & Directories' tree view; supports multi-selection (canSelectMany), batch delete, disk deletion, Unignore Directory context action, and Reveal in Explorer.
  └─ DirectoryTreeDataProvider [directoryProvider.ts] drives sidebar 'Directory Navigation' tree view showing all workspace folders including 'Root Directory Files Only', with Ignore/Unignore context actions, delete folder, and Reveal in Explorer.

Webview panel ("thumbview")
  └─ postMessage("data" | "status" | "activeFile" | "openState" | "setFocusedFolder" | "hoverLines" | "hideForTransition" | "showAfterTransition") ──┐
                                                                                                        │
media/overview.js (webview/browser side)                                                               │
  ├─ Receives data payloads, pre-indexes file text into _combinedText buffer for single-pass search,   │
  ├─ Pre-tokenizes lines on payload receipt and caches tokenized HTML (_htmlCache),                   │
  ├─ Viewport frustum culling skips offscreen tiles (y + fileH < -50 || y > rectH + 50),               │
  ├─ Dims non-selected files (opacity 0.15) when a directory or 'Root Directory Files Only' is focused, │
  ├─ Caps line pitch at 16px for short code files,                                                    │
  ├─ Maintains Set<string> openFilesSet for O(1) tab border lookups,                                  │
  ├─ Renders editor viewport bounds overlay and handles Left CTRL hold code line magnification,        │
  ├─ Posts focusWindow on mouseenter/mousemove to restore active panel focus automatically,            │
  ├─ Displays Settings & Shortcuts modal overlay with live toggles,                                   │
  ├─ Displays top toolbar popover for Directory Navigation & Ignored Patterns (Folders & Ignored),     │
  ├─ Displays custom context menu for standard VS Code Explorer operations,                           │
  └─ postMessage("ready" | "jump" | "switchTab" | "close" | "getHoverLines" | "focusWindow" | ...) ───┘
```

### Cross-module interface

The `postMessage` protocol uses string literals matched between `extension.ts` and `media/overview.js`: `"data"`, `"status"`, `"activeFile"`, `"openState"`, `"setFocusedFolder"`, `"hoverLines"`, `"hideForTransition"`, `"showAfterTransition"`, `"ready"`, `"jump"`, `"switchTab"`, `"close"`, `"getHoverLines"`, `"focusWindow"`, `"openPreview"`, `"openToSide"`, `"revealInFiles"`, `"openContainingFolder"`, `"renameFile"`, `"deleteFile"`, `"ignoreFile"`, `"copyPath"`, `"copyRelativePath"`, `"copyFile"`, `"cutFile"`, `"selectForCompare"`, `"compareWithSelected"`, `"reorderFile"`, `"setDragReorderMode"`, `"setLayoutMode"`, `"setRenderMediaThumbnails"`, `"reflow"`, `"addIgnorePattern"`, and `"removeIgnorePattern"`. When adding a command or changing its shape, note its fields in a short comment at both ends.

### Non-obvious details

- **`buildStableGrid` and tokenizers are duplicated.** Keep copies in `src/` and `media/overview.js` synchronized by hand. See DESIGN.md.
- **Search regex and whole-word patterns are duplicated.** Keep `media/overview.js`'s `rebuildSearchState()` and `extension.ts`'s `"jump"` handler synchronized by hand.
- **Parallel repository scanning and sorting.** `scanner.ts` scans workspace files in parallel batches of 50 with `Promise.all()` and sorts them alphabetically by relative path so sibling files sit adjacent in the grid.
- **View frustum culling.** Cards outside the viewport are skipped during canvas render loops.
- **Subdirectory focus dimming.** Focusing a folder dims non-focused files to opacity 0.15 without hiding them, keeping grid positions stable.
- **Maximum line pitch.** Line spacing (`stepY`) is capped at 16px max so short files do not stretch lines across the card.
- **Media aspect ratio preservation.** `drawAspectFit` in `media/overview.js` scales images and PDF Page 1 snapshots using contain logic, preserving natural aspect ratios inside grid tiles. `imageCache` clears on repository data updates, and image URIs append a timestamp query parameter (`?v=timestamp`) so edited images refresh on disk changes.
- **Pre-computed indexing and tokenization.** Search runs through `textMatches()`, backed by `rebuildSearchState()`. Plain matching stays on the pre-lowercased path (`file._combinedText.includes(searchQuery)`), or `file._combinedTextOriginal.includes(rawSearchQuery)` when Match Case is on. Whole Word and Regular Expression compile a `RegExp` against the original-case text. An invalid regex sets `searchInvalid` so callers treat tiles as non-matching rather than throwing. Line HTML syntax spans are cached in `line._htmlCache`. Search highlighting is rebuilt fresh via `buildLineHtml()` on each hover render because the query or toggles can change between hovers of the same cached line.
- **Top-level ignore consolidation.** Auto-ignore consolidates dense folders to top-level root paths (such as `BOFS/`) and prunes child subdirectories to prevent tree bloat. Folders listed in `autoIgnoreExclusions` (workspaceState) are never auto-ignored.
- **Ignore state in workspaceState.** `ignorePatterns` and `autoIgnoreExclusions` live in `ExtensionContext.workspaceState`, not in `.vscode/settings.json`. Old settings.json values migrate on first activation.
- **Multi-select tree view.** `thumbview-ignores` enables `canSelectMany: true` for Shift and Ctrl batch deletions and unignores.
- **Left CTRL hover inspection.** The magnifying overlay requires holding `Left CTRL`, throttles position updates with `requestAnimationFrame`, and fixes overlay width to `min(maxWidthAllowed, widestLine)` per file to prevent tooltip box jitter while moving across lines.
- **Automatic webview DOM focus.** `extension.ts` sends a `focusWebview` message, and `media/overview.js` calls `window.focus()` on load so `Left CTRL` hover and search typing work immediately. Background IPC messages (`data` and `openState`) do not invoke `window.focus()`, avoiding focus stealing while typing in text editors.
- **Fullscreen mode through Zen mode.** Opening Thumbview runs `workbench.action.toggleZenMode`, which snapshots and restores sidebar, panel, and aux bar visibility. Extensions cannot read workbench visibility state directly. Zen settings `zenMode.centerLayout`, `zenMode.fullScreen`, and `zenMode.hideActivityBar` are temporarily set to false, `zenMode.showTabs` is set to `"none"`, and `zenMode.singleTabGroup` is set to true to hide split editors to the right of Thumbview. Original settings are backed up in workspaceState and restored on exit or crash recovery. The sidebar remains hidden during Zen mode. Actions, settings, directory navigation, and ignored pattern management live in the webview toolbar and settings modal. A leftover backup on activation toggles Zen mode off, preventing an unmatched `enterFullscreen` from toggling Zen off instead of on. Layout operations are serialized through a promise queue with synchronously set flags so concurrent calls cannot stack blind toggles. The view-state handler ignores events while a layout operation is in flight and exits only when the panel is hidden. Zen is entered before the panel is created or revealed. On exit (`toggle-off`, `switchTab`, `jump`), the webview content is hidden with `hideForTransition` (setting `body.opacity` to 0), Zen exits, and the target editor is shown.
- **Recursive subfolder card expansion.** When root grid cells fall below 60×40px, `media/overview.js` switches to subfolder card mode, grouping files by immediate child folder into clickable cards. Folder card previews display nested child folder cards only when opening the folder would collapse into cards, using the same row-major `buildStableGrid` layout as the drilldown view. If files will be laid out individually, the preview mirrors that layout with proportional spanning heights. Clicking drills down recursively until tiles are readable.
- **Zero-reflow window resizing.** `media/overview.js` uses a constant `BASE_GRID_ASPECT = 16 / 9` and reference canvas bounds (`REF_CANVAS_W = 1200`, `REF_CANVAS_H = 800`) for layout calculations so window resizing scales tile dimensions (`cellW` and `cellH`) without reflowing tiles into different columns and rows. When the window shrinks to where tiles become unreadable (`cellW < minCellWidth || cellH < minCellHeight`), views containing subdirectories collapse into folder thumbnail cards.
- **Folder card rearranging and column bounds.** In folder cards mode, `buildStableGrid` allocates capacity based on `Math.max(orderedItems.length, displayItems.length)`, creating rows and slots for cards dropped into empty rows below. Folder card reordering inside folders (`swapCardItems`) updates `thumbview.folderCardOrders[folder]` without mutating file-level `thumbview.folderOrders[folder]` or global `fileOrder`. Dragging tiles rightward strictly bounds columns to `targetGridCols` without adding `extraCols` twice. Right-clicking "Expand Grid Space" is the sole mechanism for expanding grid columns.
- **2D spanning drag reordering.** `media/overview.js` runs `reorderSpanningItemsLocal` directly on `mouseup`, keeping untouched files in adjacent rows and columns locked to their exact coordinates and rendering the moved file at its target slot. Extension host IPC messages dispatch synchronously before disk state persistence.
- **Mouse button navigation.** Mouse buttons 3 (Back) and 4 (Forward) are handled exclusively in `mouseup`. Duplicate triggers are suppressed in `auxclick` to ensure one step of navigation per physical click.
- **Centralized UI theme colors and brand accents.** UI chrome colors derive from VS Code theme contribution points (`--vscode-editor-background`, `--vscode-foreground`, `--vscode-menu-*`, `--vscode-focusBorder`). Three fixed brand accents are defined in `src/colors.ts`: `ACCENT_SEARCH = "#dc267f"`, `ACCENT_INSPECT = "#785ef0"`, and `ACCENT_RECENCY = "#fe6100"`. The host injects them into the webview style element as CSS variables, which `media/overview.js` reads with `getThemeColor("--tv-accent-*")`.
- **Hover outline and `findFileAt`.** Hovering any tile draws a light-blue outline using `BORDER_STYLES.dragging`. The module-level `hoveredFile` resolves through `findFileAt(px, py)` on every `mousemove`. This is an exact hit test, unlike `findNearestSlot` which resolves to a `{col, row}` slot. The same color and outline style are reused for the drag ghost and drop-target outline so all three read as one consistent interaction state. Inside a focused folder, `findFileAt` tests against `activeRenderGrid.files` directly instead of iterating all workspace files.
- **Retained webview context.** `createWebviewPanel` sets `retainContextWhenHidden: true`. When Thumbview closes through `F4`, `Esc`, `jump`, or `switchTab`, the panel is backgrounded rather than disposed. Re-opening Thumbview reveals the live panel instantly without DOM re-initialization.
- **Monospace character width arithmetic.** `drawThumbnail` computes text layout using single-sample monospace font width caching (`getMonospaceCharWidth(fontSize)`), calculating token advance in $O(1)$ arithmetic (`tok.text.length * charWidth`) without calling `ctx.measureText`.
- **Tile raster caching and memoized mini-mosaics.** Code tiles render to offscreen canvases and cache in `tileRasterCache` (500 entries max), drawing cached tiles with editor viewports rendered dynamically on top. Subfolder mini-mosaics are memoized to offscreen canvases (`group._miniCache`), avoiding re-layout work while preserving visual detail.
- **Surgical file invalidation.** `invalidateScanFile(filePath)` evicts only modified files upon watcher events, and `DirectoryTreeDataProvider` consumes cached scan data.

## Terminology

The extension was renamed from **Repository Map** (`repomap`) to **Thumbview** partway through development. Every user-facing surface uses **Thumbview**. Internal state keys use the `thumbview.*` prefix (`"thumbview.seenFiles"`, `"thumbview.spanningAllocations"`, `"thumbview.spanningRows"`, `"thumbview.zenSettingsBackup"`). A one-time migration in `extension.ts` copies values from the old `repomap.*` keys on activation and deletes them. See DESIGN.md.

## Committing changes

**Do not commit unless explicitly asked.** Never offer to commit or prepare a commit message speculatively.

- Match recent repository conventions in `git log -n 5`.
- Keep bug fixes and performance refactors clearly demarcated in commit summaries.

## Branch workflow

Development takes place on personal dev branches (such as `bobby-dev`). Work is committed to the dev branch, merged into `main`, and pushed only when explicitly requested by the user.

## Responding to a reported problem, issue, or bug

When the user reports a problem, issue, or bug:
1. Investigate and pinpoint the actual root cause first.
2. Explain the cause to the user.
3. Explain your proposed solution.
4. Wait for the user's explicit approval before making any edits.

## Verifying UI and layout changes

Never attempt to launch F5 or visually verify canvas and webview changes yourself. Make the change and ask the user to press F5 to test. Do not run `npm run compile`, `npm run lint`, or `tsc` proactively unless explicitly requested by the user.
