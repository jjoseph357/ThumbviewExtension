# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. See [DESIGN.md](DESIGN.md) for the design rationale behind the architecture and behavior decisions described here.

## Keeping documentation current

Every change must update all affected documentation before the task is complete. Stale
documentation is actively harmful.

- **CLAUDE.md** — update when architecture, module responsibilities, config keys, or
  conventions change.
- **DESIGN.md** — update when a design decision changes; add a new entry under "Future
  design decisions" before or while implementing a new one, not only after.
- **README.md** — update when commands, features, or the development workflow change.
- **CODEBASE_OVERVIEW.md** — a dated audit snapshot (explicitly marked "re-verify before
  relying on specifics"), not living documentation. Don't update it for routine changes; only
  touch it if a change falsifies one of its specific claims, and prefer noting the doc as
  stale over rewriting it wholesale.
- **In-code comments** — update file-level and inline comments when the behavior or
  structure they describe changes.

## Code comments

Follow the global no-comments-by-default rule (comment the WHY, never the WHAT). On top of
that, this project's conventions:

- **Top-of-file summary** — 1–2 lines on the pure-logic modules (`scanner.ts`, `layout.ts`,
  `spanning_layout.ts`, `state.ts`) and on `media/overview.js`: what the module computes
  and what it hands back to its caller. `extension.ts` doesn't need one — its command
  registrations are self-orienting.
- **No MARK-style section comments.** This codebase doesn't use them; don't introduce them
  unprompted.
- **Duplicated logic must say so.** Anything that exists in two places (see "Non-obvious
  things worth knowing" below — `buildStableGrid`, the tokenizers) needs a one-line comment
  at each copy pointing at its twin, so an edit to one side doesn't silently leave the other
  stale.

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

`F5` starts the `watch` build task and launches an Extension Development Host window with
Thumbview loaded (`F4` there opens the minimap panel). It does **not** hot-reload — relaunch
`F5` to pick up compiled changes. Full walkthrough: README.md.

### Packaging

Situational, not everyday dev — see README.md's "Package and install a `.vsix` locally"
section for the `vsce package` steps.

## Architecture

Thumbview is a VS Code extension that renders every workspace source file as a small
syntax-highlighted "minimap" tile in a grid. There are two runtime halves that communicate
only via `webview.postMessage` — the extension host (Node, TypeScript, compiled to `out/`)
and the webview (browser JS, `media/overview.js`, not compiled/bundled, loaded as-is).

```
extension.ts (host)
 ├─ scanRepository()        [scanner.ts]         walks the workspace, applies a hand-rolled
 │                                                .gitignore emulation, reads files, splits
 │                                                into lines, coarsely categorizes each line
 │                                                (comment/import/function/class/control-flow/
 │                                                normal) into RepoFile/MiniLine.
 ├─ buildStableGrid()       [layout.ts]          uniform_grid mode: item count -> near-16:9
 │                                                grid of [col,row] slots, filled row-by-row
 │                                                (why growth never repositions an existing
 │                                                file: see DESIGN.md).
 ├─ buildSpanningGrid()     [spanning_layout.ts] spanning_grid mode: files with more lines
 │                                                occupy multiple vertically-stacked cells
 │                                                (cellsNeeded), placed column-major; per-file
 │                                                cell allocations/row count persisted across
 │                                                rescans.
 └─ PersistentFileOrder     [state.ts]           keeps file->grid-slot assignment stable across
                                                  rescans by backfilling "holes" (why: see
                                                  DESIGN.md), persisted under the key
                                                  "repomap.seenFiles" (see Terminology below).

Webview panel ("thumbview")
 └─ postMessage("data" | "status" | "activeFile" | "openState") ──────┐
                                                                       │
media/overview.js (webview/browser side)                             │
 ├─ Receives the messages above, re-tokenizes each line client-side   │
 │  (its own regex-based tokenizeJS/tokenizeCSS/tokenizeHTML etc.)    │
 │  and draws everything to a single <canvas> every frame.            │
 ├─ Has its own inline buildStableGrid() duplicate, used only when a  │
 │  folder is "focused" (breadcrumb drill-down) — that subset needs   │
 │  its own layout the extension host never computed.                │
 └─ postMessage("ready" | "jump" | "close") back to the extension ────┘
      "jump"  -> extension opens the doc, moves the cursor, and flashes
                 matching lines pink via 4 staged TextEditorDecorationTypes
                 (extension.ts, searchFlashSteps).
      "close" -> extension closes the matching tab across all tab groups.
```

### Cross-module interface

The `postMessage` protocol (`"data"`, `"status"`, `"activeFile"`, `"openState"`, `"jump"`,
`"close"`, `"ready"`) is implicit string-literal matching between `extension.ts` and `media/
overview.js` — there's no shared type to catch a typo or drift at compile time. When adding
a command or changing an existing one's shape, note its fields in a short comment at both
ends: the `postMessage(...)` call site in `extension.ts`, and the matching branch in
`overview.js`'s message listener.

### Non-obvious things worth knowing before changing this code

- **`buildStableGrid`/tokenizer logic is duplicated, not shared**, between `src/` and
  `media/overview.js` — keep both copies in sync by hand. Why the duplication exists: see
  DESIGN.md's "Duplicated grid/tokenizer logic".
- **`scanner.ts`'s per-line `category` field** is computed but not consumed anywhere — see
  the comment at its definition, and DESIGN.md's Known Limitations, before extending it.
- **`shouldIgnore` in `scanner.ts`** doesn't handle `.gitignore` negation patterns (`!foo`)
  — known limitation, not a bug to silently "fix" without checking callers. See DESIGN.md's
  "Hand-rolled .gitignore emulation".
- **Layout mode** is a user setting (`thumbview.layoutMode`), read fresh on every call.
  Switching modes clears the persisted spanning-grid allocations (`repomap
  .spanningAllocations`, `repomap.spanningRows`).
- Workspace file/tab/selection watchers in `extension.ts` are each separately debounced —
  preserve this if touching that code, it exists to avoid flooding the webview with
  postMessage calls (exact intervals: Common development tasks table below).

## Terminology

The extension was renamed from **Repository Map** (`repomap`) to **Thumbview** partway
through development — history: `CODEBASE_OVERVIEW.md` §1; why the old name still lives on
in places below: DESIGN.md's "Persisted state keys" section. Every user-facing surface uses
**Thumbview**. Several internal artifacts still carry the old name and should **not** be
casually renamed without a migration:

- `context.workspaceState` keys `"repomap.seenFiles"`, `"repomap.spanningAllocations"`,
  `"repomap.spanningRows"` (`extension.ts`, `state.ts`) — load-bearing; see DESIGN.md.
- Console log/error prefixes (`"REPOMAP ..."`, `extension.ts`) — cosmetic, safe to rename
  any time; already inconsistent with the one site using `"THUMBVIEW COMMAND EXECUTED"`.
- The "jump to line" failure message still reads `Repository Map jump failed: ...`
  (`extension.ts`) — user-facing and carries the old name; worth fixing opportunistically.
- The webview panel id `"thumbview"` already matches the new name — don't confuse it with
  the stale storage keys above.

## Committing changes

**Do not commit unless explicitly asked.** Never offer to commit or prepare a commit message
speculatively.

- Recent history mixes plain imperative subjects ("Sync package-lock.json name/engines with
  package.json") with conventional-commit prefixes ("feat: implement spanning grid layout
  mode..."). Match whichever style the most recent related commits use rather than picking
  one convention project-wide.
- Keep an unrelated bug fix out of a feature/refactor commit (or at least call it out
  separately in the message), so fixes are easy to find in `git log` later.

## Responding to a reported problem/issue/bug

When the user reports a problem, issue, or bug (as opposed to requesting a new feature or
change), do not edit code immediately. Instead:

1. Investigate and pinpoint the actual root cause first.
2. Explain the cause to the user.
3. Explain your proposed solution.
4. Wait for the user's explicit approval before making any edits.

This applies specifically to bug reports, not to feature requests or explicitly-scoped
change requests.

## Verifying UI/layout changes

Never attempt to launch the Extension Development Host (F5) or otherwise visually verify a
canvas/webview change yourself — there's no way to drive or screenshot it from here. Make
the change and ask the user to press F5 and check it looks right instead.

Don't run ad-hoc sanity-check scripts either (a scratch `node -e`, a throwaway `.ts` file) to
verify logic before/after an edit — each one is a permission prompt the user has to approve.
Reason it through by hand, and let the user run/test the real thing if they want it
verified.

**Do not run `npm run compile`, `npm run lint`, `tsc`, or any other build/verification
command proactively either** — not even just to double-check an edit compiles. This slows
the development loop down for no benefit; breakage will surface quickly once the user
actually runs it. Only run these if the user explicitly asks you to.

## Common development tasks

| Task | Where |
|---|---|
| Change the default layout mode, or add a new layout mode | `package.json` (`contributes.configuration.properties["thumbview.layoutMode"]`), `extension.ts`'s `getLayoutMode()` and `refreshRepositoryMap()`'s mode branch |
| Adjust uniform-grid packing (aspect ratio, row growth order) | `layout.ts`'s `buildStableGrid()` — and its duplicate in `media/overview.js` (see "Non-obvious things worth knowing" above) |
| Adjust spanning-grid cell allocation (lines-per-cell, compression, target aspect) | `spanning_layout.ts`'s `cellsNeeded()`/`buildSpanningGrid()` default parameters |
| Change which grid slot a file keeps across rescans / how new files backfill holes | `state.ts`'s `PersistentFileOrder` |
| Change a persisted `workspaceState` key | `extension.ts`/`state.ts` (`"repomap.seenFiles"`, `"repomap.spanningAllocations"`, `"repomap.spanningRows"`) — see "Terminology" above before renaming any of these |
| Adjust the `.gitignore` emulation used when scanning the workspace | `scanner.ts`'s `shouldIgnore()` — known not to handle `!negation` patterns |
| Add or change a command | `package.json` (`contributes.commands`, `contributes.keybindings`), `extension.ts` (`vscode.commands.registerCommand`) |
| Change the webview's HTML/CSS/Content-Security-Policy | `extension.ts`'s `getHtml()` |
| Change the tokenizer / syntax-highlight colors used inside minimap tiles | `media/overview.js`'s `tokenizeJS`/`tokenizeCSS`/`tokenizeHTML`/`tokenizeLine` |
| Change the open-tab / active-tab border colors | `media/overview.js` (`strokeStyle` literals near the tab-border drawing code — `#f97316` open, `#a855f7` active) |
| Change the search-match flash color/duration/steps shown in the real editor | `extension.ts`'s `searchFlashSteps` array and its chained `setTimeout` delays |
| Change file-watcher / cursor-update debounce timing | `extension.ts` (800ms file-watcher debounce, 150ms selection debounce) |
| Change the extension's icon | `media/icon.svg` |
| Add a new `postMessage` command between host and webview | `extension.ts` (send/receive sites) and `media/overview.js` (its message listener) — see "Cross-module interface" above |

*(Add a row here whenever a new common small tweak location is established.)*
