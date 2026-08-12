# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. See [DESIGN.md](DESIGN.md) for the design rationale behind the architecture and behavior decisions described here.

## Keeping documentation current

Every change must update all affected documentation before the task is complete. Stale documentation is actively harmful.

- **CLAUDE.md** — update when architecture, module responsibilities, config keys, or conventions change.
- **DESIGN.md** — update when a design decision changes; explain the technical *why* behind architecture decisions so researchers and maintainers understand system tradeoffs.
- **CHANGELOG.md** — update for every release following Keep a Changelog guidelines.
- **README.md** — update when commands, features, or the development workflow change.
- **CODEBASE_OVERVIEW.md** — a dated audit snapshot (explicitly marked "re-verify before relying on specifics"), not living documentation. Don't update it for routine changes; only touch it if a change falsifies one of its specific claims, and prefer noting the doc as stale over rewriting it wholesale.
- **In-code comments** — update file-level and inline comments when the behavior or structure they describe changes.

## Code comments

Follow the global no-comments-by-default rule (comment the WHY, never the WHAT). On top of that, this project's conventions:

- **Top-of-file summary** — 1–2 lines on the pure-logic modules (`scanner.ts`, `layout.ts`, `spanning_layout.ts`, `state.ts`) and on `media/overview.js`: what the module computes and what it hands back to its caller. `extension.ts` doesn't need one — its command registrations are self-orienting.
- **MARK-style section comments** are used in `media/overview.js` on the top-level render/event-handler blocks (`render()`, `mousedown`, `mousemove`, `mouseup`, ...) at the user's request, for personal navigation of the file. Don't introduce them elsewhere unprompted.
- **Duplicated logic must say so.** Anything that exists in two places (see "Non-obvious things worth knowing" below — `buildStableGrid`, the tokenizers) needs a one-line comment at each copy pointing at its twin, so an edit to one side doesn't silently leave the other stale.

## Commands

```bash
npm install          # install dependencies
npm run compile      # one-off TypeScript build: src/ -> out/
npm run watch        # incremental build, rebuilds on save (tsc -watch)
npm run lint         # eslint over src/
npm test             # vscode-test — NOTE: no test files exist yet, this will fail/no-op
```

There is no test suite yet, so there is no "run a single test" command to document.

### Running the extension while developing

`F5` starts the `watch` build task and launches an Extension Development Host window with Thumbview loaded (`F4` there opens the minimap panel). It does **not** hot-reload — relaunch `F5` to pick up compiled changes. Full walkthrough: README.md.

### Packaging

Situational, not everyday dev — see README.md's "Package and install a `.vsix` locally" section for the `vsce package` steps.

## Architecture

Thumbview is a VS Code extension that renders every workspace source file as a small syntax-highlighted "minimap" tile in a grid. There are two runtime halves that communicate only via `webview.postMessage` — the extension host (Node, TypeScript, compiled to `out/`) and the webview (browser JS, `media/overview.js`, not compiled/bundled, loaded as-is).

```
extension.ts (host)
  ├─ scanRepository()        [scanner.ts]         walks workspace in parallel batches of 50 (Promise.all), receives ignorePatterns/autoIgnoreExclusions
  │                                                as parameters from workspaceState, consolidates top-level root ignores (e.g. BOFS/), enforces safety caps
  │                                                (max 2MB per file, max 2000 lines sampled evenly spaced, max 300 chars per line),
  │                                                and respects autoIgnoreExclusions (directories the user un-ignored).
  ├─ buildStableGrid()       [layout.ts]          uniform_grid mode: item count -> near-16:9 grid slots.
  ├─ buildSpanningGrid()     [spanning_layout.ts] spanning_grid mode: tall files occupy multiple cells.
  ├─ PersistentFileOrder     [state.ts]           keeps file->grid-slot assignment stable across rescans.
  ├─ IgnoreTreeDataProvider  [ignoreProvider.ts]  drives sidebar 'Ignored Files & Directories' tree view; supports multi-selection (canSelectMany), batch delete, disk deletion, Unignore Directory context action, and Reveal in Explorer.
  └─ DirectoryTreeDataProvider [directoryProvider.ts] drives sidebar 'Directory Navigation' tree view (hierarchical, showing all workspace folders including 'Root Directory Files Only', with Ignore/Unignore context actions, delete folder, and Reveal in Explorer).

Webview panel ("thumbview")
 └─ postMessage("data" | "status" | "activeFile" | "openState" | "setFocusedFolder" | "hoverLines" | "hideForTransition" | "showAfterTransition") ──┐
                                                                                                       │
media/overview.js (webview/browser side)                                                               │
 ├─ Receives data payloads, pre-indexes file text into _combinedText buffer for 1-pass fast search,     │
 ├─ Pre-tokenizes lines on payload receipt and caches tokenized HTML (_htmlCache),                      │
 ├─ Performs viewport frustum culling (y + fileH < -50 || y > rectH + 50) for 60 FPS locked rendering,  │
 ├─ Low-lights non-selected files (opacity 0.15) when a directory or 'Root Directory Files Only' is focused to preserve layout,     │
 ├─ Enforces fixed maximum line gap (6px cap) for short code files,                                     │
 ├─ Maintains Set<string> openFilesSet for O(1) tab border lookups,                                     │
 ├─ Renders editor viewport bounds overlay and handles Left CTRL hold code line magnification,         │
 ├─ Posts focusWindow on mouseenter/mousemove to restore active panel focus automatically,              │
 ├─ Displays interactive ⚙ Actions & Shortcuts glassmorphic modal overlay,                             │
 ├─ Displays custom context menu for standard VS Code Explorer operations,                              │
 └─ postMessage("ready" | "jump" | "switchTab" | "close" | "getHoverLines" | "focusWindow" | ...) ─────┘
```

### Cross-module interface

The `postMessage` protocol (`"data"`, `"status"`, `"activeFile"`, `"openState"`, `"setFocusedFolder"`, `"hoverLines"`, `"hideForTransition"`, `"showAfterTransition"`, `"ready"`, `"jump"`, `"switchTab"`, `"close"`, `"getHoverLines"`, `"focusWindow"`, `"openPreview"`, `"openToSide"`, `"revealInFiles"`, `"openContainingFolder"`, `"renameFile"`, `"deleteFile"`, `"ignoreFile"`, `"copyPath"`, `"copyRelativePath"`, `"copyFile"`, `"cutFile"`, `"selectForCompare"`, `"compareWithSelected"`, `"reorderFile"`, `"setDragReorderMode"`) is implicit string-literal matching between `extension.ts` and `media/overview.js`. When adding a command or changing an existing one's shape, note its fields in a short comment at both ends.

### Non-obvious things worth knowing before changing this code

- **`buildStableGrid`/tokenizer logic is duplicated, not shared**, between `src/` and `media/overview.js` — keep both copies in sync by hand. See DESIGN.md.
- **Search regex/whole-word pattern-building is duplicated, not shared**, between `media/overview.js`'s `rebuildSearchState()` (drives grid/tooltip matching) and `extension.ts`'s `"jump"` message handler (drives the post-jump line-flash) — keep both copies in sync by hand.
- **Parallel Chunked Repository Scanning & Directory Sorting**: `scanner.ts` scans workspace files in parallel batches of 50 using `Promise.all()` and sorts them alphabetically by relative workspace path so sibling files in the same directory sit adjacent in grid order.
- **View Frustum Culling**: Cards outside the viewport are skipped during canvas render loops.
- **Subdirectory Focus Lowlighting**: Focusing a folder dims non-focused files to opacity 0.15 without hiding them, keeping grid positions stable.
- **Fixed Maximum Code Line Spacing**: Line spacing (`stepY`) is capped at 6px max so small files do not stretch lines apart.
- **Media Aspect Ratio Preservation & Instant Cache Refresh**: `drawAspectFit` in `media/overview.js` scales images and PDF Page 1 snapshots using `object-fit: contain` logic, preserving natural aspect ratios inside grid tiles. `imageCache` is cleared on repository data updates and image URIs append a timestamp query parameter (`?v=timestamp`) so updated images refresh instantly on disk changes.
- **Pre-Computed Indexing & Tokenization**: Search runs through `textMatches()`, backed by `rebuildSearchState()`. Plain (non-regex, non-whole-word) matching stays on the fast pre-lowercased path — `file._combinedText.includes(searchQuery)` case-insensitively, or `file._combinedTextOriginal.includes(rawSearchQuery)` when Match Case is on. Whole Word and Use Regular Expression compile a `RegExp` (case-insensitive unless Match Case is on) and test it against the original-case text instead; an uncompilable regex sets `searchInvalid` so callers stop treating every tile as non-matching rather than crash. Line HTML is cached in `line._htmlCache`, but only the syntax-color spans — search highlighting is rebuilt fresh via `buildLineHtml()` on every hover render since the query/toggles can change between hovers of the same cached line.
- **Top-Level Ignore Consolidation**: Auto-ignore consolidates dense folders to top-level root paths (e.g. `BOFS/`) and prunes child subdirectories to prevent tree bloat. Folders listed in `autoIgnoreExclusions` (workspaceState) are never auto-ignored.
- **Ignore State in workspaceState**: `ignorePatterns` and `autoIgnoreExclusions` are stored in `ExtensionContext.workspaceState` (VS Code's internal per-workspace storage), not in `.vscode/settings.json`. Old settings.json values are migrated on first activation.
- **Multi-Select TreeView**: `thumbview-ignores` enables `canSelectMany: true` for `Shift/Ctrl` batch deletions and unignores.
- **Left CTRL Hover & rAF Throttling**: Magnifying overlay requires `Left CTRL` hold, throttles position updates via `requestAnimationFrame`, and fixes overlay width to `min(maxWidthAllowed, widestLine)` per file to prevent tooltip box size jitter while moving across lines.
- **Automatic Webview DOM Focus**: `extension.ts` sends `focusWebview` message (and `media/overview.js` calls `window.focus()` upon panel load) so `Left CTRL` hover and search typing work immediately. Background IPC messages (`data` and `openState`) do not invoke `window.focus()` to prevent focus stealing while typing in text editors.
- **Fullscreen Mode via Zen Mode**: Opening Thumbview runs `workbench.action.toggleZenMode` (which natively snapshots and restores sidebar/panel/aux bar visibility — extensions cannot read workbench visibility state) plus a symmetric `toggleMaximizeEditorGroup` when multiple editor groups exist. `zenMode.centerLayout`, `zenMode.fullScreen`, and `zenMode.hideActivityBar` are temporarily forced off, and `zenMode.showTabs` is forced to `"none"` (originals backed up in workspaceState, restored on exit or next activation after a crash); the sidebar is re-shown via `toggleSidebarVisibility` after entering zen (no setting prevents zen from hiding it) so users can access ignore/directory tree views. A leftover backup on activation also toggles zen mode off, since VS Code persists zen state across sessions and an unmatched `enterFullscreen` would toggle zen *off* instead of on. All layout ops are serialized through a promise queue with synchronously-set flags so concurrent calls from the command path and `onDidChangeViewState` can't stack blind toggles; the view-state handler ignores events while a layout op is in flight (plus a 300ms grace window) and exits only when the panel is hidden, since zen/maximize churn makes the `active` flag flicker. The maximize toggle acts on the active editor group, so it only ever fires while Thumbview's group is active — on exit the panel is re-revealed first if needed — otherwise split widths skew every cycle. Zen is entered *before* the panel is created/revealed; on exit (toggle-off, `switchTab`, `jump`), the webview content is hidden via `hideForTransition` (setting `body.opacity` to 0), zen exits, and *then* the target editor is shown — exiting zen first avoids the race where zen layout restoration re-activates the Thumbview tab. The `onDidChangeViewState` enter path brackets the awaited zen/maximize with `hideForTransition`/`showAfterTransition` webview messages to mask the layout transition when the user manually switches to the Thumbview tab.
- **Recursive Subfolder Card Expansion**: When root grid cells fall below 60×40px, `media/overview.js` switches to a subfolder card mode that groups files by immediate child folder, rendering clickable cards. Clicking drills in recursively until tiles are readable.
- **Drag-to-Reorder is Order-Array-Only, Layout-Agnostic**: Dragging a tile posts `"reorderFile"` with `sourceId`/`targetId` file ids (`targetId: null` means "append to the end"); `PersistentFileOrder.swap()`/`.move()` (`state.ts`) mutate only the flat `seenFiles` order array, never grid coordinates — `buildStableGrid`/`buildSpanningGrid` recompute geometry fresh from that array on every layout refresh, so the same drag logic works unmodified in both `uniform_grid` and `spanning_grid`. `thumbview.dragReorderMode` (`swap` trades the two tiles' positions; `shift` inserts-and-shifts everything between old/new position by one) is a Command Palette + sidebar-link setting only — the Actions modal is reference-only HTML and was deliberately not given interactive controls for this, consistent with how `layoutMode` is also just described there, not toggled from it.
- **General Hover Outline & `findFileAt`**: Hovering any tile draws a light-blue `BORDER_STYLES.dragging` outline (module-level `hoveredFile`, resolved via `findFileAt(px, py)` on every `mousemove` — an exact-hit-only test, unlike `findNearestFile`'s drag-drop nearest-fallback which always resolves to the closest tile even off a direct hit). The same color and outline style is deliberately reused for the drag ghost and drop-target outline, so hovering, dragging, and the drop target all read as one consistent "you're interacting with this tile" affordance; all three are inset/thinner than the search-match/active/open tile borders so they don't visually compete with those states.

## Terminology

The extension was renamed from **Repository Map** (`repomap`) to **Thumbview** partway through development. Every user-facing surface uses **Thumbview**. Internal state keys now use the `thumbview.*` prefix (`"thumbview.seenFiles"`, `"thumbview.spanningAllocations"`, `"thumbview.spanningRows"`, `"thumbview.zenSettingsBackup"`); a one-time migration in `extension.ts` copies values from the old `repomap.*` keys on activation and deletes them (see DESIGN.md).

## Committing changes

**Do not commit unless explicitly asked.** Never offer to commit or prepare a commit message speculatively.

- Match recent repository conventions in `git log -n 5`.
- Keep bug fixes and performance refactors clearly demarcated in commit summaries.

## Branch workflow

Development takes place on personal dev branches (e.g. `bobby-dev`). Work is committed to the dev branch, merged into `main`, and pushed only when explicitly requested by the user.

## Responding to a reported problem/issue/bug

When the user reports a problem, issue, or bug:
1. Investigate and pinpoint the actual root cause first.
2. Explain the cause to the user.
3. Explain your proposed solution.
4. Wait for the user's explicit approval before making any edits.

## Verifying UI/layout changes

Never attempt to launch F5 or visually verify canvas/webview changes yourself. Make the change and ask the user to press F5 to test. Do not run `npm run compile`, `npm run lint`, or `tsc` proactively unless explicitly requested by the user.
