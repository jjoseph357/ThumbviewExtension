// The three fixed brand accents used across Thumbview's UI, independent of the user's
// VS Code theme. Referenced by name everywhere else (CSS custom properties in the
// injected webview <style>, and directly here for editor decorations) — never redefine
// these hex values anywhere else.
export const ACCENT_SEARCH = "#dc267f";   // search highlighting (matches, jump-flash decoration)
export const ACCENT_INSPECT = "#785ef0";  // Ctrl-hold interactive inspection tooltip
export const ACCENT_RECENCY = "#fe6100";  // open-tab / recency indicator

// hex -> rgba(...) string at a given alpha. Duplicated in media/overview.js (see
// comment there) since the webview can't import this module — keep both in sync by hand.
export function withAlpha(hex: string, alpha: number): string {
    const clean = hex.replace("#", "");
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
