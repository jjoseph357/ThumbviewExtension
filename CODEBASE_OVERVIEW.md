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

_Update (2026-07-21): the diagram that used to live in this section predated
`spanning_layout.ts` and the `setUniformGrid`/`setSpanningGrid` commands, and had drifted
out of sync with the code. To avoid maintaining two competing copies, it's been removed
from here — **the current, maintained diagram lives in [CLAUDE.md](CLAUDE.md)'s
Architecture section.** Design rationale for the choices it shows (canvas-based rendering,
the host/webview split, the two layout modes, the duplicated grid/tokenizer logic, the
stable-grid/hole-filling algorithms, etc.) lives in [DESIGN.md](DESIGN.md)._

### Key files (`src/`)

See CLAUDE.md's Architecture section — kept in one place rather than duplicated here,
since this list is exactly what went stale above.

### Build / tooling

Current build/lint/test commands: see CLAUDE.md's Commands section or README.md. Two
findings from the original audit, still true as of this update:

- **No test files exist** despite the `@vscode/test-cli` scaffold (`.vscode-test.mjs`,
  `npm test`) — see §3 item 6 below and DESIGN.md's Known Limitations.
- ~~Two `.vsix` packages were committed directly into the repo.~~ **Resolved** — both were
  removed (`git rm`) since `*.vsix` is gitignored and the package should be built from
  source via `vsce package` (see README → Development).

## 3. Areas most in need of documentation

Ordered roughly by how much confusion/risk each one currently causes:

1. ~~The root vs. `repo-map/` duplication.~~ **Resolved** — see the update note at the top
   of this document. The layout is now flat, with the active project directly at the repo
   root.
2. ~~Extension ⇄ webview message protocol undocumented.~~ **Documented** (2026-07-21) — the
   `postMessage` contract and the "keep both sides in sync by hand" rule are now written up
   in CLAUDE.md's Architecture / "Cross-module interface" sections. There's still no shared
   TypeScript type enforcing it at compile time — that gap is tracked in DESIGN.md's Known
   Limitations, since fixing it is a code change, not just a doc one.
3. **Whether `scanner.ts`'s `MiniLine.category` is actually used — flagged, not resolved.**
   A comment at its definition and DESIGN.md's Known Limitations now record that it's
   computed host-side but not consumed by the webview. Whether to remove it or wire it up
   is still an open decision, not yet made.
4. ~~The `.gitignore` emulation in `scanner.ts` (`shouldIgnore`) undocumented.~~
   **Documented** (2026-07-21) — the negation-pattern limitation now has a code comment and
   its own DESIGN.md section ("Hand-rolled .gitignore emulation"). The limitation itself
   (no `!foo` support) is unchanged.
5. ~~`PersistentFileOrder`'s hole-filling behavior unexplained.~~ **Resolved** (2026-07-21)
   — the why is now written up in DESIGN.md's "Hole-filling instead of compaction" section.
6. **No tests**, despite a full test-runner scaffold (`vscode-test`, `.vscode-test.mjs`)
   being present. Either write tests for `layout.ts`/`state.ts` (both are pure functions/
   classes, easy to unit test) or note that testing is intentionally deferred. Also tracked
   in DESIGN.md's Known Limitations.
7. **`CHANGELOG.md` is stale.** Still says "Initial release" / references the "repo-map"
   name at version 0.0.3, despite the rename and multiple version bumps.
8. ~~No CONTRIBUTING or architecture doc explaining the canvas-based rendering approach.~~
   **Resolved** (2026-07-21) — see DESIGN.md's "Why a single `<canvas>`, not one DOM element
   per tile" section.
9. **Release/publish process** is undocumented — whether this extension is meant to reach
   the VS Code Marketplace, and if so, how versions get tagged/published. (Whether `.vsix`
   files belong in the repo is resolved: they don't — see above.)
10. ~~No root `LICENSE`.~~ **Resolved** — `LICENSE` now lives at the repo root as part of
    the flatten.

## 4. Suggested next step

With the duplication resolved and items #2, #4, #5, #8 now documented (see CLAUDE.md/
DESIGN.md), the remaining open gaps are #6 (no tests), #7 (stale `CHANGELOG.md`), and #9
(undocumented release process) — process/hygiene items, none of which require touching the
extension's runtime behavior.
