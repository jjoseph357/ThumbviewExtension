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
- **No MARK-style section comments.** This codebase doesn't use them; don't introduce them unprompted.
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
  ├─ scanRepository()        [scanner.ts]         walks workspace in parallel batches of 50 (Promise.all), applies custom ignorePatterns setting,
  │                                                consolidates top-level root ignores (e.g. BOFS/), and enforces safety caps
  │                                                (max 2MB per file, max 2000 lines sampled evenly spaced, max 300 chars per line).
  ├─ buildStableGrid()       [layout.ts]          uniform_grid mode: item count -> near-16:9 grid slots.
  ├─ buildSpanningGrid()     [spanning_layout.ts] spanning_grid mode: tall files occupy multiple cells.
  ├─ PersistentFileOrder     [state.ts]           keeps file->grid-slot assignment stable across rescans.
  ├─ IgnoreTreeDataProvider  [ignoreProvider.ts]  drives sidebar 'Ignored Files & Directories' tree view; supports multi-selection (canSelectMany) & batch delete.
  └─ DirectoryTreeDataProvider [directoryProvider.ts] drives sidebar 'Directory Navigation' tree view (hierarchical, with cumulative file counts).

Webview panel ("thumbview")
 └─ postMessage("data" | "status" | "activeFile" | "openState" | "setFocusedFolder" | "hoverLines") ──┐
                                                                                                       │
media/overview.js (webview/browser side)                                                               │
 ├─ Receives data payloads, pre-indexes file text into _combinedText buffer for 1-pass fast search,     │
 ├─ Pre-tokenizes lines on payload receipt and caches tokenized HTML (_htmlCache),                      │
 ├─ Performs viewport frustum culling (y + fileH < -50 || y > rectH + 50) for 60 FPS locked rendering,  │
 ├─ Maintains Set<string> openFilesSet for O(1) tab border lookups,                                     │
 ├─ Renders editor viewport bounds overlay and handles Left CTRL hold code line magnification,         │
 ├─ Posts focusWindow on mouseenter/mousemove to restore active panel focus automatically,              │
 ├─ Displays interactive ⚙ Actions & Shortcuts glassmorphic modal overlay,                             │
 ├─ Displays custom context menu for standard VS Code Explorer operations,                              │
 └─ postMessage("ready" | "jump" | "switchTab" | "close" | "getHoverLines" | "focusWindow" | ...) ─────┘
```

### Cross-module interface

The `postMessage` protocol (`"data"`, `"status"`, `"activeFile"`, `"openState"`, `"setFocusedFolder"`, `"hoverLines"`, `"ready"`, `"jump"`, `"switchTab"`, `"close"`, `"getHoverLines"`, `"focusWindow"`, `"openPreview"`, `"openToSide"`, `"revealInFiles"`, `"openContainingFolder"`, `"renameFile"`, `"deleteFile"`, `"ignoreFile"`, `"copyPath"`, `"copyRelativePath"`, `"copyFile"`, `"cutFile"`, `"selectForCompare"`, `"compareWithSelected"`) is implicit string-literal matching between `extension.ts` and `media/overview.js`. When adding a command or changing an existing one's shape, note its fields in a short comment at both ends.

### Non-obvious things worth knowing before changing this code

- **`buildStableGrid`/tokenizer logic is duplicated, not shared**, between `src/` and `media/overview.js` — keep both copies in sync by hand. See DESIGN.md.
- **Parallel Chunked Repository Scanning**: `scanner.ts` scans workspace files in parallel batches of 50 using `Promise.all()` to keep initial load times under 500ms.
- **View Frustum Culling**: Cards outside the viewport are skipped during canvas render loops.
- **Pre-Computed Indexing & Tokenization**: Text search uses `file._combinedText.includes(searchQuery)`, and line HTML is cached in `line._htmlCache`.
- **Top-Level Ignore Consolidation**: Auto-ignore consolidates dense folders to top-level root paths (e.g. `BOFS/`) and prunes child subdirectories to prevent tree bloat.
- **Multi-Select TreeView**: `thumbview-ignores` enables `canSelectMany: true` for `Shift/Ctrl` batch deletions.
- **Left CTRL Hover & rAF Throttling**: Magnifying overlay requires `Left CTRL` hold and throttles position updates via `requestAnimationFrame`.
- **Automatic Panel Focus**: Webview posts `focusWindow` on mouseover to invoke `activePanel.reveal(undefined, true)`.

## Terminology

The extension was renamed from **Repository Map** (`repomap`) to **Thumbview** partway through development. Every user-facing surface uses **Thumbview**. Internal state keys (`"repomap.seenFiles"`, `"repomap.spanningAllocations"`, `"repomap.spanningRows"`) retain their original names for backward compatibility (see DESIGN.md).

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
