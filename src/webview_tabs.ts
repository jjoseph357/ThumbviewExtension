// Recognizes Thumbview's own editor tab from the tab API. Returns whether a tab's webview viewType
// belongs to Thumbview.

export const THUMBVIEW_VIEW_TYPE = "thumbview";

/**
 * VS Code reports an extension webview tab's viewType with a "mainThreadWebview-" prefix
 * ("mainThreadWebview-thumbview"), not the bare viewType passed to createWebviewPanel. Comparing
 * against "thumbview" alone never matched, which silently disabled every split-editor fallback
 * that needs to find Thumbview's tab.
 */
export function isThumbviewViewType(viewType: unknown): boolean {
    // Exact matches only: another extension's "…-thumbview" webview is not Thumbview.
    return viewType === THUMBVIEW_VIEW_TYPE || viewType === `mainThreadWebview-${THUMBVIEW_VIEW_TYPE}`;
}
