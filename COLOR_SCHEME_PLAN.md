# Centralize UI chrome colors on the user's VS Code theme (+ 3 fixed brand accents)

> **Status:** Planning only — not yet implemented. Written 2026-08-07 on `woody-dev`.
> Update or delete this doc once the feature lands (fold the durable parts into
> CLAUDE.md/DESIGN.md per this repo's documentation-currency rule).

## Context

Thumbview's UI chrome (webview HTML/CSS, canvas-drawn tile chrome, and the editor
jump-flash decoration) is currently ~134 separate hardcoded hex/rgba literals split
across `src/extension.ts` (67) and `media/overview.js` (67), with zero centralization
today (no `:root` CSS variables, no shared color constant anywhere). Most of it
approximates VS Code's default Dark+ theme (`#252526`, `#cccccc`, `#1e1e1e`-ish grays),
so it looks correct only for users on that one theme and doesn't adapt to Light+,
high-contrast, or custom themes at all. Separately, three specific accent colors
(search highlighting, the Ctrl-hold inspection tooltip, and the open-tab/"recency"
indicator) are deliberately theme-*independent* — fixed brand colors chosen from an
accessible/colorblind-safe palette — and are currently scattered as slightly-different
literal hexes in 20+ places instead of one.

Goal: every other UI chrome color should derive from the user's actual VS Code theme
(both UI-chrome colors and — confirmed out of scope for this pass — NOT the
per-token syntax-highlighting palette inside the minimap tiles, which stays hardcoded
until it's tackled separately). The three fixed accents get defined in exactly one
place and referenced everywhere else by name, so tweaking one of them is a one-line change.

## Confirmed scope decisions (from user)

- **Search highlight (`#dc267f`)** replaces *every* current pink/magenta usage
  (`#ec4899` / `rgb(236,72,153)` family) in both files: the editor jump-flash decoration
  (`extension.ts:134-163`, 12 occurrences), and in `overview.js` — tile search-match
  border/filename text (3 render paths), minimap matched-line band, and the tooltip
  search-highlight span (10 occurrences total).
- **Interactive inspection (`#785ef0`)** replaces *only* the Ctrl-hold inspection
  tooltip's highlight (`overview.js:1881,1885` — the `>` marker and hovered-line
  background/left-border in the magnifier tooltip). The other current purple uses —
  "active file" tile border (3 render paths), folder-card border/accent, and the
  modal/toggle/actions-btn "active hover" chrome in `extension.ts` — are **not** this
  accent; they become theme-derived (see mapping below, `--vscode-focusBorder`).
- **Recency (`#fe6100`)** replaces the existing "open tab" orange indicator
  (`overview.js:1345,1416,1502`, currently `#f97316`) — renamed/repurposed as-is, no
  behavior change, just the constant and its color.
- **Not in scope**: the syntax-token palette inside `colorForCategory()` and the
  `tokenize*()` functions (`overview.js`) — tabled for a later pass, per the user.
- **Judgment call, flagging for visibility**: the folder-card "density preview bar"
  (`overview.js:1295-1296`) computes an `hsla()` hue from `fileCount` — it's a data-driven
  gradient (like a mini heatmap), not a fixed chrome color reflecting theme identity, so
  the plan leaves its formula as-is rather than trying to theme-derive it. Flag for the
  user to override if they'd rather it also react to the theme somehow.

## Design

### 1. `src/colors.ts` (new) — the single source of truth

```ts
// The three fixed brand accents used across Thumbview's UI, independent of the user's
// VS Code theme. Referenced by name everywhere else (CSS custom properties in the
// injected webview <style>, and directly here for editor decorations) — never redefine
// these hex values anywhere else.
export const ACCENT_SEARCH = "#dc267f";   // search highlighting (matches, jump-flash decoration)
export const ACCENT_INSPECT = "#785ef0";  // Ctrl-hold interactive inspection tooltip
export const ACCENT_RECENCY = "#fe6100";  // open-tab / recency indicator

// hex -> rgba(...) string at a given alpha. Duplicated in media/overview.js (see
// comment there) since the webview can't import this module — keep both in sync by hand.
export function withAlpha(hex: string, alpha: number): string { ... }
```

### 2. `src/extension.ts`

- Import `ACCENT_SEARCH`, `withAlpha` from `./colors`; replace all 12 literals in the
  `createTextEditorDecorationType` calls (`extension.ts:134-163`) with
  `withAlpha(ACCENT_SEARCH, 0.35)` etc. (border literals too — `1px dashed ${ACCENT_SEARCH}`).
- In the webview HTML template, add a `:root { --tv-accent-search: ${ACCENT_SEARCH};
  --tv-accent-inspect: ${ACCENT_INSPECT}; --tv-accent-recency: ${ACCENT_RECENCY}; }`
  block (`--tv-` prefix, matching this repo's existing `thumbview.*` internal-key
  convention) so `overview.js` can read them the same way it already reads
  `--vscode-*` vars via the existing `getThemeColor()` helper (`overview.js:780-783`) —
  no new mechanism needed webview-side, just more CSS custom properties to look up.
- Rewrite every other literal in the `<style>` block (`extension.ts:1172-1474`) to
  `var(--vscode-*)`, using VS Code's real theme contribution points instead of
  approximating them. Representative mapping (applies by purpose, not enumerated
  line-by-line — several purposes recur 2-3x across near-duplicate selectors):

  | Current purpose | Was | Becomes |
  |---|---|---|
  | Page background / canvas bg | `#18181c` | `var(--vscode-editor-background)` |
  | Default foreground text | `#e1e1e6`, `#cccccc`, `#d4d4d8` | `var(--vscode-foreground)` |
  | Muted/secondary text | `#a0a0a5`, `#707075`, `#505055` | `var(--vscode-descriptionForeground)` |
  | Context menu bg/border/text | `#252526` / `#454545` / `#cccccc` | `var(--vscode-menu-background)` / `var(--vscode-menu-border)` / `var(--vscode-menu-foreground)` |
  | Menu item hover | `#04395e` | `var(--vscode-menu-selectionBackground)` (+ `-selectionForeground`) |
  | Menu danger/destructive hover | `#900c3f` | `var(--vscode-statusBarItem-errorBackground)` |
  | Hover tooltip bg/border/text | `rgba(20,20,25,.98)` / purple / `#d4d4d4` | `var(--vscode-editorHoverWidget-background/-border/-foreground)` (exact contribution points for hover widgets) |
  | Modal bg/border/text | `rgba(20,20,26,*)` / purple / `#d4d4d8` | `var(--vscode-editorWidget-background/-border/-foreground)` |
  | kbd chip bg/border/text | `rgba(255,255,255,*)` / `#f472b6` | `var(--vscode-keybindingLabel-background/-border/-foreground)` (dedicated contribution group, exact fit) |
  | Regex-error outline | `rgba(239,68,68,.8)` | `var(--vscode-inputValidation-errorBorder)` |
  | Search input text / placeholder | `#ffffff` / `#707075` | `var(--vscode-input-foreground)` / `var(--vscode-input-placeholderForeground)` |
  | "Active" toggle/hover accent (search-option-btn.active, actions-btn:hover, modal-section-title, modal border) — was purple | `#a855f7` / `rgba(168,85,247,*)` | `var(--vscode-focusBorder)` (VS Code's canonical "this is active/accented" color) |
  | Box-shadows | `rgba(0,0,0,.25/.5/.75/.85)` | `var(--vscode-widget-shadow)` |
  | Translucent glass-panel backgrounds/borders (breadcrumbs, search bar, actions-btn) | `rgba(30,30,34,.85)` / `rgba(255,255,255,.08/.12)` | `color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent)` / similar with `var(--vscode-widget-border)` — modern `color-mix()` keeps the existing glassmorphism look while deriving from the theme (VS Code's Electron/Chromium is well past `color-mix()` support) |

- Update the `postMessage`/architecture doc-comments and CLAUDE.md per the repo's
  documentation-currency rule (new `src/colors.ts` module, `--tv-accent-*` custom
  properties as part of the host→webview contract).

### 3. `media/overview.js`

- Near the top (after `getThemeColor` is defined), add:
  ```js
  // Fixed brand accents — single source of truth is src/colors.ts, injected here as
  // CSS custom properties by extension.ts. Never hardcode these hexes elsewhere.
  const ACCENT_SEARCH = getThemeColor("--tv-accent-search");
  const ACCENT_INSPECT = getThemeColor("--tv-accent-inspect");
  const ACCENT_RECENCY = getThemeColor("--tv-accent-recency");

  // hex -> rgba(...) at a given alpha. Duplicated from src/colors.ts (webview can't
  // import it) — keep both in sync by hand.
  function withAlpha(hex, alpha) { ... }
  ```
  (No literal fallback hex on these three lookups — unlike the existing `--vscode-*`
  lookups elsewhere, which keep sensible fallbacks, these three must always resolve to
  the host-injected value so there's truly one place that can define them.)
- Replace all pink search-match sites (minimap band, 3x tile border/label, tooltip
  highlight span, tooltip line-row bg/border — `overview.js:64, 1008, 1339, 1353, 1410,
  1424, 1496, 1510, 1883, 1888`) with `ACCENT_SEARCH` / `withAlpha(ACCENT_SEARCH, x)`.
- Replace the Ctrl-hold inspection tooltip's purple (`overview.js:1881, 1885`) with
  `ACCENT_INSPECT` / `withAlpha(ACCENT_INSPECT, 0.18)`.
- Replace the "open tab" orange (`overview.js:1345, 1416, 1502`) with `ACCENT_RECENCY`.
- Replace the "active file" tile border (3x, currently `#a855f7`) and folder-card
  border/accent (`overview.js:1263, 1268, 1342, 1413, 1499`) with
  `getThemeColor("--vscode-focusBorder", ...)`, matching the `extension.ts` mapping above.
- Replace remaining plain UI-chrome literals (status text, tile background/border/label
  colors, image/PDF placeholder chrome, editor-viewport overlay band) with the
  corresponding `getThemeColor("--vscode-*", fallback)` calls — editor-viewport overlay
  band specifically maps to `--vscode-editor-selectionBackground` (a closer semantic fit
  than a plain translucent white, since it's the same "this range is in view" concept).
  PDF "Page 1" header label switches from hardcoded crimson+white to
  `--vscode-badge-background` / `--vscode-badge-foreground` (VS Code's dedicated
  colored-label contribution point — auto-contrasts across themes, a better fit than a
  fixed brand-red banner).
- Leave `colorForCategory()`/`tokenize*()` and the folder-card `hsla()` density formula
  untouched (out of scope, see above).

### Files touched

- `src/colors.ts` (new) — the 3 constants + `withAlpha`.
- `src/extension.ts` — decoration colors, `:root` custom-property injection, full
  `<style>` block var rewrite.
- `media/overview.js` — `ACCENT_*` consts + `withAlpha` (duplicated, commented per
  CLAUDE.md's duplication rule), all canvas/DOM literal replacements.
- `CLAUDE.md` — note the new color-centralization scheme and where the source of truth
  lives, per the repo's own documentation-currency rule.

## Verification (manual — user runs `F5`, per project convention)

1. Default Dark+ theme: confirm no visual regression — chrome should look effectively
   identical to today (the mapped `--vscode-*` vars resolve close to the old literals
   under Dark+).
2. Switch VS Code to a Light theme, then a High Contrast theme (Command Palette →
   "Preferences: Color Theme") with the panel open — confirm every piece of chrome
   (tooltip, context menu, modal, search bar, breadcrumbs, tile borders/backgrounds,
   placeholders) visibly adapts and stays legible, while the search-match pink,
   inspection purple, and open-tab/recency orange stay exactly `#dc267f`/`#785ef0`/`#fe6100`
   regardless of theme.
3. Confirm the search "jump to line" fade-out decoration in the real editor still fades
   through the same 4 steps, now via `withAlpha(ACCENT_SEARCH, ...)`.
4. Confirm Ctrl-hold inspection tooltip highlight is visually unchanged (still the fixed purple).
5. Spot-check that switching themes live (while the panel is open) updates chrome without
   needing a reload, since `--vscode-*` vars update automatically — only the `--tv-accent-*`
   custom properties (injected once at panel HTML generation) and anything read into a
   JS top-level const at script load won't need to change since they're theme-independent by design.
