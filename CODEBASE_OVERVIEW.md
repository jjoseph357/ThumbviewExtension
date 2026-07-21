# Thumbview — Codebase Overview & Documentation Audit

_Generated 2026-07-21 by scanning the repository. This is a snapshot — re-verify against
current code before relying on specifics like line numbers or file names._

> **Update (2026-07-21):** Section 1 below describes a problem that has since been fixed on
> branch `restructure/flatten-repo-map`. The repo originally contained two copies of the
> extension — a stale root prototype (`repomap`, v0.0.1) and the active project nested in
> `repo-map/` (`thumbview`, v0.0.3). The stale root copy was deleted and `repo-map/`'s
> contents were moved up to the repository root (via `git mv`, preserving history), so
> `src/`, `media/`, `package.json`, etc. at the root are now the real, active project. The
> section is left below as a record of what the duplication looked like and why it existed;
> paths elsewhere in this document have been updated to match the new, flattened layout.

## 1. What this repository actually contains (historical — see note above)

There were **two copies of the extension** living side by side, at different stages of
development. This was the single most important thing to understand before touching
anything here, and it wasn't documented anywhere in the repo itself.

| | Root (`/src`, `/media`, `/package.json`) | `repo-map/` subfolder |
|---|---|---|
| Extension name | "Repository Map" (`repomap`) | "Thumbview" (`thumbview`) |
| `package.json` version | 0.0.1 | 0.0.3 |
| VS Code engine | `^1.92.0` | `^1.107.0` |
| Commands | `repomap.open` only | `thumbview.open`, `thumbview.reflow` |
| `extension.ts` size | 117 lines, minimal | 348 lines, full-featured |
| `overview.js` (webview) size | 188 lines | 782 lines |
| State persistence | none | `PersistentFileOrder` (`state.ts`) |
| Build output (`out/`) | not present at root | present, compiled |
| Packaged `.vsix` | none | `thumbview-0.0.1.vsix`, `thumbview-0.0.2.vsix` |

Git history (`refactor: rename repository-map to thumbview...`) confirmed this wasn't two
unrelated projects — the root copy was the **original prototype**, and `repo-map/` was where
active development moved to and continued under the new name "Thumbview". The root copy
was dead/superseded code that had never been deleted.

**Resolution:** the stale root `src/`/`media/`/`package.json` were removed, and everything
from `repo-map/` was moved up to the repository root. `repo-map/node_modules/` and
`repo-map/out/` (both of which were, unusually, tracked in git despite being build
artifacts) were untracked and deleted from disk rather than moved, and a root `.gitignore`
(`node_modules/`, `out/`, `*.vsix`, `.vscode-test/`) was added so they stay untracked going
forward. The repo is now a normal single-package layout with no nested duplicate.

## 2. What the extension does

Thumbview is a VS Code extension that renders every source file in the workspace as a small
syntax-highlighted "minimap" tile in a grid, similar to a wall of thumbnails. Per the
`README.md`:

- Renders all workspace files as a 2D grid of code minimaps.
- Custom multi-color syntax highlighting per tile (own tokenizer, not VS Code's TextMate
  grammars).
- Live search box that filters/highlights matching files and lines.
- Double-click a file to "focus" into its folder (breadcrumb navigation).
- Hovering a minimap line shows a floating tooltip with the real code (± ~7 lines) around
  the cursor.
- Clicking a line in a tile jumps the real editor to that file/line and flashes matches.
- Open editor tabs get an orange border; the active tab gets a purple border; cursor
  position is shown as a translucent overlay band on the relevant tile.
- `Thumbview: Reflow Layout` command resets the remembered file ordering.
- Bound to `F4`.

### Architecture / data flow

```
extension.ts (host/Node side)
 ├─ scanRepository()        [scanner.ts]   — walks workspace via vscode.workspace.findFiles,
 │                                            manually filters against .gitignore rules,
 │                                            reads every file, splits into lines, and
 │                                            classifies each line into a coarse category
 │                                            (comment / import / function / class /
 │                                            control-flow / normal).
 ├─ buildStableGrid()        [layout.ts]    — turns an item count into a near-16:9 grid of
 │                                            [col,row] slots, growing row-by-row so that
 │                                            existing files don't jump to new positions
 │                                            when the file count grows ("stable" grid).
 ├─ PersistentFileOrder      [state.ts]     — keeps file→grid-slot assignment stable across
 │                                            rescans by filling "holes" left by deleted
 │                                            files with newly added ones, persisted in
 │                                            `context.workspaceState` under
 │                                            "repomap.seenFiles" (note: key still uses the
 │                                            old "repomap" name post-rename).
 └─ Webview panel (`thumbview`)
      └─ postMessage("data" | "status" | "activeFile" | "openState") ─────┐
                                                                          │
media/overview.js (webview/browser side)                                │
 ├─ Receives the messages above, re-tokenizes each line client-side      │
 │  (tokenizeJS/tokenizeCSS/tokenizeHTML — a second, independent,        │
 │  regex-based syntax highlighter separate from scanner.ts's coarse     │
 │  categorizer) and draws everything to a single <canvas> each frame.  │
 ├─ Own client-side buildStableGrid() duplicate — used only when a       │
 │  folder is "focused" (breadcrumb drill-down), since that subset needs │
 │  its own layout the extension host never computed.                   │
 └─ postMessage("ready" | "jump") back to the extension ─────────────────┘
      "jump" → extension opens the doc, moves the cursor, and flashes
                matching lines pink via 4 staged TextEditorDecorationTypes.
```

Two things worth flagging because they're non-obvious from reading either file in
isolation:

- **The tokenizer/categorizer logic is duplicated, not shared.** `scanner.ts` does a cheap
  per-line categorization on the extension-host side (used for nothing visible right now,
  as far as this scan could tell — `MiniLine.category` is computed but doesn't appear to be
  read by `overview.js`, which does its own full tokenization from raw text). Confirm
  whether `category` is dead weight before extending it.
- **`buildStableGrid` exists in two places**: `src/layout.ts` (compiled to `out/layout.js`,
  used by the extension host) and inline inside `media/overview.js` (used only for the
  focused-folder sub-grid). The two copies must be kept in sync by hand — there's no shared
  module between them because the webview can't `import` extension-host TypeScript directly.

### Key files (`src/`)

- `extension.ts` — activation, command registration (`thumbview.open`, `thumbview.reflow`),
  webview lifecycle, file-system/tab/selection watchers (each debounced), and the "jump to
  line + flash matches" logic.
- `scanner.ts` — workspace file walk + naive `.gitignore`-pattern-to-regex translator
  (`shouldIgnore`) + per-line coarse categorization.
- `layout.ts` — the stable-grid packing algorithm.
- `state.ts` — `PersistentFileOrder`, the hole-filling algorithm that keeps a file's grid
  position stable across rescans.

### Build / tooling

- TypeScript → `out/` via `tsc -p .` (or `npm run watch`).
- ESLint via `eslint.config.mjs` (flat config, `typescript-eslint`).
- `npm test` runs `@vscode/test-cli` (`vscode-test`) — **but no test files exist anywhere in
  the repo** (only `.vscode-test.mjs` config, no `test/` directory). The test command would
  currently either fail or no-op.
- `.vscode/tasks.json` + `launch.json` wire up F5 debugging with a `tsc -watch` background
  build task — standard `yo code` scaffold, undocumented beyond the auto-generated comments.
- ~~Two `.vsix` packages were committed directly into the repo.~~ **Resolved** — both were
  removed (`git rm`) since `*.vsix` is gitignored and the package should be built from
  source via `vsce package` (see README → Development). There's still no documented
  release/publish process (e.g. whether this extension is meant to reach the VS Code
  Marketplace) if that becomes relevant later.

## 3. Areas most in need of documentation

Ordered roughly by how much confusion/risk each one currently causes:

1. ~~The root vs. `repo-map/` duplication.~~ **Resolved** — see the update note at the top
   of this document. The layout is now flat, with the active project directly at the repo
   root.
2. **Extension ⇄ webview message protocol.** The `postMessage` contract (`ready`, `data`,
   `status`, `activeFile`, `openState`, `jump`) is implicit in matching string literals
   across two files with no shared types and no comment describing the protocol as a whole.
   A short doc (or a shared `interface Message = ...` union type) would make it much safer
   to extend.
3. **Whether `scanner.ts`'s `MiniLine.category` is actually used.** If it's dead code left
   over from before the webview grew its own tokenizer, it should be documented as such or
   removed; if it's meant to be consumed somewhere, that's a bug worth flagging.
4. **The `.gitignore` emulation in `scanner.ts` (`shouldIgnore`).** Hand-rolled glob→regex
   translation with fallback substring matching on regex-construction failure. No comment
   explains which gitignore features are/aren't supported (e.g. negation patterns `!foo`
   are not handled — they'd be treated as a literal-to-match rule, effectively the opposite
   of their intended meaning). Worth a comment or a switch to a maintained gitignore-parsing
   library.
5. **`PersistentFileOrder`'s hole-filling behavior.** The "why" — keeping tiles visually
   stable across rescans instead of resorting — is not explained anywhere, so the somewhat
   unusual hole/backfill algorithm in `state.ts` could look like a bug to someone unfamiliar
   with the intent.
6. **No tests**, despite a full test-runner scaffold (`vscode-test`, `.vscode-test.mjs`)
   being present. Either write tests for `layout.ts`/`state.ts` (both are pure functions/
   classes, easy to unit test) or note that testing is intentionally deferred.
7. **`CHANGELOG.md` is stale.** Still says "Initial release" / references the "repo-map"
   name at version 0.0.3, despite the rename and multiple version bumps.
8. **No CONTRIBUTING or architecture doc** explaining the canvas-based rendering approach
   (why a single `<canvas>` instead of DOM nodes per tile — almost certainly a performance
   choice for large workspaces, but that reasoning isn't recorded anywhere).
9. **Release/publish process** is undocumented — whether this extension is meant to reach
   the VS Code Marketplace, and if so, how versions get tagged/published. (Whether `.vsix`
   files belong in the repo is resolved: they don't — see above.)
10. ~~No root `LICENSE`.~~ **Resolved** — `LICENSE` now lives at the repo root as part of
    the flatten.

Build/run instructions (`npm install`, `compile`/`watch`, F5 debugging, `vsce package`) have
been added to `README.md`'s new "Development" section, addressing part of gap #8.

## 4. Suggested next step

With the duplication resolved, the next highest-leverage items are #2 (documenting or
typing the postMessage protocol) and #3 (confirming whether `MiniLine.category` is dead
code) — both are small, contained changes that reduce the risk of the next feature change
breaking something silently.
