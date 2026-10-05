// Builds the webview page (markup, CSS, CSP, and the nonce'd scripts) that extension.ts sets as the
// panel's html. Returns the complete HTML string; the page's behavior lives in media/overview.js.
import * as vscode from "vscode";
import { ACCENT_SEARCH, ACCENT_INSPECT, ACCENT_RECENCY } from "./colors";

// Builds the webview's HTML shell. media/overview.js is loaded via a nonce'd <script>
// tag under a strict CSP (script-src limited to that nonce) so no inline/remote script
// can run in the panel — see getNonce() below.
export function getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    openKeybindingLabel: string = "F4"
): string {
    const isMac = process.platform === "darwin";
    const jsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "overview.js")
    );
    const pdfJsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "pdfjs", "pdf.min.js")
    );
    const pdfWorkerUri = webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "media", "pdfjs", "pdf.worker.min.js")
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Thumbview</title>

    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob: data: ${webview.cspSource}; connect-src ${webview.cspSource} blob: data:;"
    >

    <meta name="viewport" content="width=device-width, initial-scale=1.0">

    <style>
        :root {
            --tv-accent-search: ${ACCENT_SEARCH};
            --tv-accent-inspect: ${ACCENT_INSPECT};
            --tv-accent-recency: ${ACCENT_RECENCY};
        }

        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: var(--vscode-editor-background, #18181c);
            color: var(--vscode-foreground, #e1e1e6);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            user-select: none;
        }

        /* Hidden until overview.js reveals a frame rendered at a stable size (inline opacity wins). */
        body {
            opacity: 0;
        }

        /* Visually hidden but read by screen readers. */
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
        }

        /* Keyboard focus is always visible on DOM controls; the canvas draws its own ring. */
        button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
            outline: 2px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 1px;
        }
        canvas:focus-visible {
            outline: none;
        }

        /* High contrast themes: controls get explicit borders; state is not conveyed by fill alone. */
        body.vscode-high-contrast button, body.vscode-high-contrast-light button,
        body.vscode-high-contrast input, body.vscode-high-contrast-light input {
            border: 1px solid var(--vscode-contrastBorder, CanvasText) !important;
        }
        body.vscode-high-contrast button.active, body.vscode-high-contrast-light button.active {
            outline: 2px solid var(--vscode-contrastActiveBorder, Highlight);
        }

        @media (forced-colors: active) {
            button, input, .menu-popover, .menu-modal {
                border: 1px solid ButtonText !important;
                forced-color-adjust: auto;
            }
            button.active {
                outline: 2px solid Highlight;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                transition: none !important;
                animation: none !important;
            }
        }

        #canvas-container {
            position: relative;
            width: 100%;
            height: 100%;
        }

        canvas {
            display: block;
            width: 100%;
            height: 100%;
        }

        /* Float controls for search & navigation */
        .controls-overlay {
            position: absolute;
            top: 16px;
            left: 16px;
            right: 16px;
            display: flex;
            justify-content: flex-start;
            align-items: center;
            pointer-events: none;
            gap: 12px;
        }

        .breadcrumb-container {
            display: flex;
            align-items: center;
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #1e1e22) 90%, #888888 10%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 13px;
            pointer-events: auto;
            box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.15));
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .breadcrumb-item {
            cursor: pointer;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            transition: color 0.15s ease;
        }

        .breadcrumb-item:hover {
            color: var(--vscode-foreground, #ffffff);
        }

        .breadcrumb-separator {
            margin: 0 8px;
            color: var(--vscode-descriptionForeground, #505055);
        }

        .search-container {
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #1e1e22) 90%, #888888 10%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 8px;
            padding: 2px;
            pointer-events: auto;
            box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.15));
            display: flex;
            align-items: center;
        }

        .search-input {
            background: transparent;
            border: none;
            outline: none;
            color: var(--vscode-input-foreground, var(--vscode-foreground, #ffffff));
            font-size: 13px;
            padding: 6px 10px;
            width: 180px;
            transition: width 0.2s ease;
        }

        .search-input.regex-error {
            outline: 1px solid var(--vscode-inputValidation-errorBorder, rgba(239, 68, 68, 0.8));
            outline-offset: -1px;
        }

        .search-input:focus {
            width: 240px;
        }

        .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground, #707075));
        }

        .search-option-btn {
            background: transparent;
            border: none;
            outline: none;
            color: var(--vscode-descriptionForeground, #707075);
            cursor: pointer;
            font-size: 14px;
            padding: 0 8px;
        }

        .search-option-btn:hover {
            color: var(--vscode-foreground, #ffffff);
        }
        
        .search-option-btn.active {
            background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 20%, transparent);
            border: 1px solid var(--vscode-focusBorder, #007fd4);
            border-radius: 4px;
            color: var(--vscode-foreground, #ffffff);
        }

        /* Magnifying floating code tooltip */
        /* Pointer hover feedback over the canvas (overview.js updateHoverOutline); never takes input. */
        #hover-outline {
            position: absolute;
            display: none;
            box-sizing: border-box;
            border: 2px solid #648fff;
            border-radius: 2px;
            pointer-events: none;
        }

        #hover-tooltip {
            position: absolute;
            display: none;
            background: var(--vscode-editorHoverWidget-background, rgba(20, 20, 25, 0.98));
            backdrop-filter: blur(12px);
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-focusBorder, rgba(168, 85, 247, 0.6)));
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 12px 36px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.75));
            font-family: Consolas, "Liberation Mono", Courier, monospace;
            font-size: 13px;
            color: var(--vscode-editorHoverWidget-foreground, #d4d4d4);
            pointer-events: none;
            z-index: 1000;
            max-width: 750px;
            line-height: 1.4;
            white-space: pre;
            tab-size: 4;
            -moz-tab-size: 4;
            overflow: hidden;
        }

        .tooltip-filename {
            font-family: system-ui, -apple-system, sans-serif;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.15));
            padding-bottom: 4px;
            font-size: 12px;
        }

        /* Right-click Context Menu */
        #context-menu {
            position: absolute;
            display: none;
            background: var(--vscode-menu-background, #252526);
            border: 1px solid var(--vscode-menu-border, rgba(255, 255, 255, 0.12));
            border-radius: 5px;
            padding: 4px 0;
            box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
            z-index: 4000;
            min-width: 220px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, #cccccc);
        }

        .menu-item {
            padding: 5px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            font-size: 12px;
            color: var(--vscode-menu-foreground, #cccccc);
            user-select: none;
            transition: background 0.1s ease;
        }

        .menu-item:hover {
            background: var(--vscode-menu-selectionBackground, #04395e);
            color: var(--vscode-menu-selectionForeground, #ffffff);
        }

        .menu-item-label {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .menu-item-key {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            margin-left: auto;
            padding-left: 12px;
            flex-shrink: 0;
            letter-spacing: 0.2px;
        }

        .menu-item:hover .menu-item-key {
            color: var(--vscode-menu-selectionForeground, #ffffff);
            opacity: 0.85;
        }

        .menu-item.danger:hover {
            background: var(--vscode-statusBarItem-errorBackground, #900c3f);
            color: #ffffff;
        }

        .menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground, rgba(255, 255, 255, 0.08));
            margin: 4px 0;
        }

        .top-bar-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
            pointer-events: auto;
        }

        .toolbar-btn {
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.12)));
            border-radius: 4px;
            color: var(--vscode-foreground, #d0d0d5);
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 2px 6px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.2));
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
            position: relative;
        }

        .toolbar-btn:hover {
            background: color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 80%, rgba(255, 255, 255, 0.1));
            border-color: rgba(255, 255, 255, 0.25);
            color: var(--vscode-foreground, #ffffff);
        }

        .toolbar-btn.active {
            background: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.12));
            border-color: var(--vscode-focusBorder, #007fd4);
            color: var(--vscode-foreground, #ffffff);
        }

        .toolbar-btn-icon {
            display: inline-block;
            vertical-align: middle;
            flex-shrink: 0;
            opacity: 0.9;
        }

        .toolbar-btn:hover .toolbar-btn-icon,
        .toolbar-btn.active .toolbar-btn-icon {
            opacity: 1;
        }

        .badge {
            background: var(--vscode-badge-background, #4d4d4d);
            border-radius: 10px;
            padding: 1px 6px;
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-badge-foreground, #ffffff);
        }

        /* Clean Minimalist Dropdown Popovers */
        .menu-popover {
            position: absolute;
            top: 56px;
            right: 16px;
            width: 380px;
            max-width: 92vw;
            max-height: 75vh;
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.14)));
            border-radius: 6px;
            box-shadow: 0 10px 30px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.45));
            z-index: 3000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-size: 12px;
            color: var(--vscode-foreground, #cccccc);
            pointer-events: auto;
        }

        .menu-popover::before, .menu-modal::before {
            content: "";
            display: block;
            height: 2px;
            width: 100%;
            background: var(--vscode-button-background, #0e639c);
            flex-shrink: 0;
        }

        .popover-header {
            flex-shrink: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            background: var(--vscode-editorWidget-headerBackground, color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 90%, #ffffff 10%));
        }

        .popover-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: 0.2px;
        }

        .popover-close {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .popover-close:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
            color: var(--vscode-foreground, #ffffff);
        }

        .folders-popover-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr;
            flex: 1 1 0%;
            min-height: 0;
            height: 100%;
            overflow: hidden;
        }

        .popover-column {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            height: 100%;
            padding: 10px;
            overflow: hidden;
            box-sizing: border-box;
        }

        .popover-column-left {
            border-right: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
        }

        .popover-column-header {
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground, #8a8a93));
            margin-bottom: 8px;
            padding-bottom: 5px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .popover-count-badge {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground, #8a8a93);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 1px 6px;
            border-radius: 10px;
        }

        .popover-body {
            flex: 1 1 0%;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 2px 4px 6px 0;
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25)) transparent;
        }

        .popover-body::-webkit-scrollbar {
            width: 8px;
        }

        .popover-body::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.12);
            border-radius: 4px;
        }

        .popover-body::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25));
            border-radius: 4px;
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-body::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.45));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-body::-webkit-scrollbar-thumb:active {
            background: var(--vscode-scrollbarSlider-activeBackground, rgba(255, 255, 255, 0.65));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .popover-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.1s ease, border-color 0.1s ease;
            font-size: 12px;
            color: var(--vscode-foreground, #cccccc);
            user-select: none;
            border-left: 2px solid transparent;
        }

        .popover-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
            color: var(--vscode-list-hoverForeground, #ffffff);
        }

        .popover-item.active {
            background: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.1));
            border-left: 2px solid var(--vscode-focusBorder, #007fd4);
            color: var(--vscode-list-activeSelectionForeground, #ffffff);
            font-weight: 500;
        }
        /* The dimmed count color fails contrast on the selection background. */
        .popover-item.active .popover-item-count {
            color: inherit;
        }

        .popover-chevron-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            padding: 0;
            margin: 0 2px 0 0;
            background: transparent;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            color: var(--vscode-foreground, #cccccc);
            flex-shrink: 0;
            transition: background-color 0.15s ease, color 0.15s ease;
        }

        .popover-chevron-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.12));
            color: var(--vscode-foreground, #ffffff);
        }

        .item-icon-label {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
            flex: 1;
        }

        .folder-name-text,
        .pattern-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .path-sep {
            opacity: 0.35;
            margin: 0 1px;
        }

        .pattern-type-badge {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 1px 5px;
            border-radius: 3px;
            font-weight: 500;
            margin-left: auto;
            margin-right: 4px;
            flex-shrink: 0;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--vscode-descriptionForeground, #8a8a93);
        }

        .popover-item-count {
            color: var(--vscode-descriptionForeground, #8a8a93);
            font-size: 11px;
            margin-left: auto;
            padding-left: 8px;
            flex-shrink: 0;
        }

        .popover-add-bar {
            flex-shrink: 0;
            display: flex;
            gap: 6px;
            padding-bottom: 8px;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
        }

        .popover-input {
            flex: 1;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
            border-radius: 3px;
            color: var(--vscode-input-foreground, #cccccc);
            padding: 4px 8px;
            font-size: 12px;
            font-family: inherit;
            outline: none;
            transition: border-color 0.1s ease;
        }

        .popover-input:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }

        .popover-btn-action {
            background: var(--vscode-button-background, #0e639c);
            border: 1px solid transparent;
            border-radius: 3px;
            color: var(--vscode-button-foreground, #ffffff);
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: background 0.12s ease;
        }

        .popover-btn-action:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }

        .remove-pattern-btn {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .remove-pattern-btn:hover {
            background: rgba(239, 68, 68, 0.15);
            color: var(--vscode-errorForeground, #f87171);
        }

        .popover-action-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            padding: 2px 7px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.12s ease;
            margin-left: 8px;
            flex-shrink: 0;
        }

        .popover-action-btn:hover {
            background: rgba(239, 68, 68, 0.15);
            border-color: rgba(239, 68, 68, 0.4);
            color: var(--vscode-errorForeground, #f87171);
        }

        .popover-empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 28px 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground, #707075);
            font-size: 12px;
        }

        .popover-empty-state .empty-hint {
            font-size: 11px;
            margin-top: 4px;
            opacity: 0.7;
            max-width: 220px;
        }

        /* Clean Minimalist Settings Modal */
        .menu-modal {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: none;
            width: 540px;
            max-width: 90vw;
            max-height: 84vh;
            background: var(--vscode-editorWidget-background, #222227);
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(255, 255, 255, 0.14)));
            border-radius: 6px;
            box-shadow: 0 12px 36px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
            z-index: 3000;
            font-size: 13px;
            color: var(--vscode-foreground, #cccccc);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        #actions-modal {
            display: none;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground, #ffffff);
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            padding: 10px 16px;
            background: var(--vscode-editorWidget-headerBackground, color-mix(in srgb, var(--vscode-editorWidget-background, #222227) 90%, #ffffff 10%));
            flex-shrink: 0;
        }

        .modal-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
            letter-spacing: 0.2px;
        }

        .modal-close {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .modal-close:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
            color: var(--vscode-foreground, #ffffff);
        }

        .modal-content-scroll {
            padding: 16px 20px;
            overflow-y: auto;
            max-height: calc(84vh - 48px);
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25)) transparent;
        }

        .modal-content-scroll::-webkit-scrollbar {
            width: 8px;
        }

        .modal-content-scroll::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.12);
            border-radius: 4px;
        }

        .modal-content-scroll::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.25));
            border-radius: 4px;
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .modal-content-scroll::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.45));
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        .modal-section {
            margin-bottom: 20px;
        }

        .modal-section:last-child {
            margin-bottom: 4px;
        }

        .modal-section-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground, #8a8a93));
            font-weight: 600;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
            padding-bottom: 5px;
        }

        .setting-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 9px 0;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.05));
        }

        .setting-row:last-child {
            border-bottom: none;
        }

        .setting-text {
            padding-right: 16px;
            min-width: 0;
        }

        .setting-name {
            font-weight: 500;
            color: var(--vscode-settings-headerForeground, var(--vscode-foreground, #ffffff));
            font-size: 13px;
        }

        .setting-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            margin-top: 2px;
            line-height: 1.4;
        }

        .segmented-control {
            display: inline-flex;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.1));
            border-radius: 4px;
            padding: 2px;
            gap: 2px;
            flex-shrink: 0;
        }

        .seg-btn {
            background: transparent;
            border: none;
            border-radius: 3px;
            color: var(--vscode-descriptionForeground, #a0a0a5);
            padding: 4px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.12s ease;
        }

        .seg-btn:hover {
            color: var(--vscode-foreground, #ffffff);
            background: rgba(255, 255, 255, 0.04);
        }

        .seg-btn.active {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            font-weight: 500;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
        }

        .action-trigger-btn {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            border: 1px solid var(--vscode-button-secondaryBorder, rgba(255, 255, 255, 0.1));
            border-radius: 4px;
            color: var(--vscode-button-secondaryForeground, #ffffff);
            padding: 5px 12px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.12s ease, border-color 0.12s ease;
            flex-shrink: 0;
        }

        .action-trigger-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .setting-input-wrapper {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }

        .setting-dimension-group {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .setting-input {
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
            border-radius: 4px;
            color: var(--vscode-input-foreground, #ffffff);
            padding: 4px 8px;
            font-size: 12px;
            font-family: inherit;
            outline: none;
            width: 58px;
            text-align: right;
            transition: border-color 0.12s ease;
            box-sizing: border-box;
            -moz-appearance: textfield;
            appearance: textfield;
        }

        .setting-input::-webkit-outer-spin-button,
        .setting-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .setting-input-dim {
            width: 50px;
            text-align: center;
        }

        .setting-input:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }

        .setting-input-unit {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            min-width: 14px;
        }

        .setting-dim-sep {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8a8a93);
            user-select: none;
        }

        /* Clean Desktop Toggle Control with Accent */
        .fullscreen-notice {
            position: absolute;
            left: 50%;
            bottom: 20px;
            transform: translateX(-50%);
            z-index: 60;
            display: flex;
            align-items: center;
            gap: 10px;
            max-width: calc(100% - 32px);
            box-sizing: border-box;
            padding: 10px 12px 10px 16px;
            border-radius: 6px;
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-foreground, #cccccc);
            border: 1px solid var(--vscode-widget-border, #454545);
            box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
            font-size: 13px;
        }
        .fullscreen-notice[hidden] {
            display: none;
        }
        .shortcut-legend {
            position: absolute;
            left: 16px;
            bottom: 12px;
            z-index: 55;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px 14px;
            max-width: calc(100% - 32px);
            box-sizing: border-box;
            padding: 5px 6px 5px 10px;
            border-radius: 4px;
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-descriptionForeground, #9d9d9d);
            border: 1px solid var(--vscode-widget-border, #454545);
            font-size: 12px;
            opacity: 0.92;
            /* Tiles underneath stay clickable and hoverable; only the close button takes input. */
            pointer-events: none;
        }
        .shortcut-legend[hidden] {
            display: none;
        }
        /* Folders auto-ignore hid (overview.js syncAutoHiddenChip); bottom right, clear of the legend. */
        .auto-hidden-chip {
            position: absolute;
            right: 16px;
            bottom: 12px;
            z-index: 55;
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 2px 4px 2px 2px;
            border-radius: 4px;
            background: var(--vscode-editorWidget-background, #252526);
            color: var(--vscode-foreground, #cccccc);
            border: 1px solid var(--vscode-widget-border, #454545);
            font-size: 12px;
        }
        .auto-hidden-chip[hidden] {
            display: none;
        }
        .auto-hidden-open {
            border: none;
            background: transparent;
            color: var(--vscode-textLink-foreground, #3794ff);
            font: inherit;
            padding: 2px 6px;
            cursor: pointer;
        }
        .auto-hidden-open:hover {
            text-decoration: underline;
        }
        .auto-hidden-open:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
        }
        .shortcut-legend kbd {
            font-family: inherit;
            padding: 0 4px;
            border-radius: 3px;
            color: var(--vscode-keybindingLabel-foreground, #cccccc);
            background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.17));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(51, 51, 51, 0.6));
        }
        .shortcut-legend-close {
            pointer-events: auto;
            border: none;
            background: transparent;
            color: inherit;
            font-size: 14px;
            line-height: 1;
            padding: 0 4px;
            cursor: pointer;
        }
        .shortcut-legend-close:hover {
            color: var(--vscode-foreground, #cccccc);
        }
        .shortcut-legend-close:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
        }
        .fullscreen-notice kbd {
            font-family: inherit;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.17));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(51, 51, 51, 0.6));
        }
        .notice-btn {
            flex: none;
            padding: 4px 10px;
            border-radius: 2px;
            border: 1px solid var(--vscode-button-secondaryBorder, transparent);
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ffffff);
            font: inherit;
            cursor: pointer;
        }
        .notice-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .notice-btn-primary {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
        }
        .notice-btn-primary:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .notice-btn:focus-visible {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 2px;
        }
        @media (max-width: 560px) {
            .fullscreen-notice {
                flex-wrap: wrap;
            }
        }
        .toggle-control {
            position: relative;
            display: inline-flex;
            align-items: center;
            cursor: pointer;
            user-select: none;
            flex-shrink: 0;
        }

        .toggle-control input {
            opacity: 0;
            width: 0;
            height: 0;
            position: absolute;
        }

        .toggle-track {
            width: 36px;
            height: 18px;
            background: var(--vscode-input-background, #1a1a1e);
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
            border-radius: 10px;
            position: relative;
            transition: all 0.15s ease;
            display: block;
        }

        .toggle-thumb {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 12px;
            height: 12px;
            background: var(--vscode-descriptionForeground, #8a8a93);
            border-radius: 50%;
            transition: transform 0.15s ease, background 0.15s ease;
        }

        .toggle-control input:checked + .toggle-track {
            background: var(--vscode-button-background, #0e639c);
            border-color: var(--vscode-button-background, #0e639c);
        }

        .toggle-control input:checked + .toggle-track .toggle-thumb {
            transform: translateX(18px);
            background: #ffffff;
        }

        .shortcuts-table {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .shortcut-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 0;
            font-size: 12px;
        }

        .shortcut-label {
            color: var(--vscode-foreground, #cccccc);
        }

        .shortcut-keys {
            color: var(--vscode-descriptionForeground, #8a8a93);
            font-size: 11px;
        }

        .kbd {
            background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.12));
            border: 1px solid var(--vscode-keybindingLabel-border, rgba(128, 128, 128, 0.25));
            border-bottom: 2px solid var(--vscode-keybindingLabel-bottomBorder, rgba(128, 128, 128, 0.35));
            border-radius: 3px;
            padding: 2px 6px;
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            font-size: 11px;
            font-weight: 500;
            color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground, #dcdce0));
            box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.1);
            display: inline-block;
        }

        .shortcut-config-box {
            margin-top: 12px;
            padding: 10px 14px;
            background: var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-editor-background, #222227) 85%, #888888 15%));
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
    </style>
</head>
<body>
    <div id="canvas-container" role="main">
        <h1 class="sr-only">Thumbview</h1>
        <canvas id="map" tabindex="0" role="application" aria-roledescription="file grid" aria-label="Thumbview files" aria-describedby="grid-help"></canvas>
        <div id="hover-outline" aria-hidden="true"></div>
        <div id="search-help" class="sr-only">Enter opens the first match. Down Arrow moves to the matches, then the arrow keys move between them. Escape clears the search.</div>
        <div id="grid-help" class="sr-only">Arrow keys move between files and folders. Home and End jump to the first and last. Enter opens. Shift+F10 opens the context menu. Hold Control to magnify the focused file. Alt+Arrow moves the focused tile. Type to search.</div>
        <div id="sr-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
        <div id="hover-tooltip"></div>
        <div id="context-menu" role="menu" aria-label="Actions" tabindex="-1"></div>
        
        <div id="folders-popover" class="menu-popover" role="dialog" aria-modal="false" aria-labelledby="folders-popover-title" style="display: none; width: 720px; max-width: 94vw; height: 560px; max-height: 82vh;">
            <div class="popover-header">
                <div class="popover-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="opacity:0.9;"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.08"/></svg>
                    <span id="folders-popover-title">Folders &amp; Ignored Items</span>
                </div>
                <button class="popover-close" id="close-folders-popover" title="Close (Esc)" aria-label="Close Folders and Ignored Items">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"/></svg>
                </button>
            </div>
            <div class="folders-popover-grid">
                <!-- Left column: Shown Folders -->
                <div class="popover-column popover-column-left">
                    <div class="popover-column-header">
                        <span>Active Directories</span>
                        <span id="shown-folders-count" class="popover-count-badge">0</span>
                    </div>
                    <div class="popover-body" id="folders-list"></div>
                </div>

                <!-- Right column: Ignored Patterns & Folders -->
                <div class="popover-column popover-column-right">
                    <div class="popover-column-header">
                        <span>Ignored Patterns</span>
                        <span id="ignores-count" class="popover-count-badge">0</span>
                    </div>
                    <div class="popover-add-bar">
                        <input type="text" id="add-ignore-input" class="popover-input" placeholder="e.g. src/temp/ or *.log" spellcheck="false">
                        <button id="add-ignore-btn" class="popover-btn-action">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 2.5V13.5M2.5 8H13.5"/></svg>
                            <span>Add</span>
                        </button>
                    </div>
                    <div class="popover-body" id="ignores-list"></div>
                </div>
            </div>
        </div>

        <div id="actions-modal" class="menu-modal" role="dialog" aria-modal="true" aria-labelledby="actions-modal-title">
            <div class="modal-header">
                <div class="modal-header-title">
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.9;"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span id="actions-modal-title">Settings &amp; Shortcuts</span>
                </div>
                <button class="modal-close" id="close-modal" title="Close (Esc)" aria-label="Close Settings and Shortcuts">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"/></svg>
                </button>
            </div>
            <div class="modal-content-scroll">
                <div class="modal-section">
                    <div class="modal-section-title">Layout &amp; Grid</div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Layout Mode</div>
                            <div class="setting-desc">Spanning grid scales tall files across multiple vertical slots</div>
                        </div>
                        <div class="segmented-control">
                            <button id="layout-spanning-btn" class="seg-btn">Spanning</button>
                            <button id="layout-uniform-btn" class="seg-btn">Uniform</button>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Drag-to-Reorder Mode</div>
                            <div class="setting-desc">Choose between swapping positions or reflowing adjacent tiles</div>
                        </div>
                        <div class="segmented-control">
                            <button id="drag-swap-btn" class="seg-btn">Swap</button>
                            <button id="drag-shift-btn" class="seg-btn">Shift</button>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="media-thumbnails-setting-name">Media Thumbnails</div>
                            <div class="setting-desc">Render image and PDF page 1 previews directly inside thumbnail tiles</div>
                        </div>
                        <label class="toggle-control">
                            <input type="checkbox" id="media-thumbnails-toggle" aria-labelledby="media-thumbnails-setting-name" checked>
                            <span class="toggle-track">
                                <span class="toggle-thumb"></span>
                            </span>
                        </label>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="fullscreen-setting-name">Open Fullscreen</div>
                            <div class="setting-desc">Open Thumbview in Zen mode so code stays readable. Turn off to open it as a normal editor tab.</div>
                        </div>
                        <label class="toggle-control">
                            <input type="checkbox" id="fullscreen-toggle" aria-labelledby="fullscreen-setting-name" checked>
                            <span class="toggle-track">
                                <span class="toggle-thumb"></span>
                            </span>
                        </label>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="compression-setting-name">Compression Percentage</div>
                            <div class="setting-desc">When code shrinks to this percentage of its height in a cell, the tile expands one cell taller (0% disables, 1% to 20% recommended)</div>
                        </div>
                        <div class="setting-input-wrapper">
                            <input type="number" id="compression-percentage-input" aria-labelledby="compression-setting-name" class="setting-input" min="0" max="25" step="1" value="5">
                            <span class="setting-input-unit">%</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Tile Size Before Collapse</div>
                            <div class="setting-desc">Minimum tile width and height in pixels before grouping files into folder cards</div>
                        </div>
                        <div class="setting-dimension-group">
                            <input type="number" id="min-cell-width-input" class="setting-input setting-input-dim" min="10" max="500" step="5" value="40" title="Minimum width (px)" aria-label="Minimum tile width in pixels">
                            <span class="setting-dim-sep">×</span>
                            <input type="number" id="min-cell-height-input" class="setting-input setting-input-dim" min="10" max="500" step="5" value="28" title="Minimum height (px)" aria-label="Minimum tile height in pixels">
                            <span class="setting-input-unit">px</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name" id="auto-ignore-setting-name">Auto-Ignore Threshold</div>
                            <div class="setting-desc">Automatically ignore folders containing more than this number of files (0 disables)</div>
                        </div>
                        <div class="setting-input-wrapper">
                            <input type="number" id="auto-ignore-threshold-input" aria-labelledby="auto-ignore-setting-name" class="setting-input" min="0" max="10000" step="5" value="30">
                            <span class="setting-input-unit">files</span>
                        </div>
                    </div>
                    <div class="setting-row">
                        <div class="setting-text">
                            <div class="setting-name">Reflow Layout</div>
                            <div class="setting-desc">Reset grid slot arrangement back to repository directory order</div>
                        </div>
                        <button id="reflow-layout-btn" class="action-trigger-btn">Reflow Grid</button>
                    </div>
                </div>

                <div class="modal-section">
                    <div class="modal-section-title">Keyboard &amp; Mouse Shortcuts</div>
                    <div class="shortcuts-table">
                        <div class="shortcut-row">
                            <span class="shortcut-label">Open / Focus Thumbview</span>
                            <span class="shortcut-keys"><span class="kbd" id="open-shortcut-label">${escapeHtml(openKeybindingLabel)}</span></span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Code Magnifier Preview</span>
                            <span class="shortcut-keys"><span class="kbd">${isMac ? "Cmd / Ctrl" : "Ctrl"}</span> + Hover</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Jump to Line in Editor</span>
                            <span class="shortcut-keys"><span class="kbd">Left Click</span> Tile Line</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Close Document / Tab</span>
                            <span class="shortcut-keys"><span class="kbd">Middle Click</span> or <span class="kbd">×</span></span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Isolate Folder</span>
                            <span class="shortcut-keys"><span class="kbd">Left Click</span> Folder Header / Item</span>
                        </div>
                        <div class="shortcut-row">
                            <span class="shortcut-label">Context Menu</span>
                            <span class="shortcut-keys"><span class="kbd">${isMac ? "Right Click / ⌃Click" : "Right Click"}</span> Tile</span>
                        </div>
                    </div>
                    <div class="shortcut-config-box">
                        <div class="setting-text">
                            <div class="setting-name">Global Shortcut Hotkey</div>
                            <div class="setting-desc">Current keybinding: <span class="kbd" id="open-shortcut-label-2">${escapeHtml(openKeybindingLabel)}</span></div>
                        </div>
                        <button id="change-hotkey-btn" class="action-trigger-btn">Configure Keybinding</button>
                    </div>
                </div>

                <div class="modal-section">
                    <div class="modal-section-title">Feedback &amp; Issues</div>
                    <div class="setting-desc">
                        Report bugs, request features, or view documentation at
                        <a href="https://github.com/jjoseph357/thumbview-issues/issues" target="_blank" style="color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline;">thumbview-issues</a>.
                    </div>
                </div>
            </div>
        </div>
        <div class="controls-overlay">
            <div class="search-container" role="search">
                <input type="text" id="search-input" class="search-input" title="Begin typing with the Thumbview open to Search" aria-label="Search files" aria-describedby="search-help" placeholder="Search files (e.g. auth)...">
                <button id="search-match-case" class="search-option-btn" aria-label="Match Case" aria-pressed="false" title="Match Case (${isMac ? "⌥C" : "Alt+C"})">Aa</button>
                <button id="search-match-word" class="search-option-btn" aria-label="Match Whole Word" aria-pressed="false" title="Match Whole Word (${isMac ? "⌥W" : "Alt+W"})">[ab]</button>
                <button id="search-use-regex" class="search-option-btn" aria-label="Use Regular Expression" aria-pressed="false" title="Use Regular Expression (${isMac ? "⌥X" : "Alt+X"})">.*</button>
                <button id="clear-search" class="search-option-btn" aria-label="Clear search" title="Clear Search (${isMac ? "⌘⌫" : "Ctrl+Backspace"})" style="display: none;">&times;</button>
            </div>
            <div id="breadcrumbs" class="breadcrumb-container" style="display: none;">
                <span class="breadcrumb-item" id="breadcrumb-root">root</span>
            </div>
            <div class="top-bar-actions">
                <button id="folders-btn" class="toolbar-btn" title="Folders &amp; Ignored" aria-haspopup="dialog" aria-expanded="false" aria-controls="folders-popover">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.75 3.75C1.75 3.06 2.31 2.5 3 2.5H6.05C6.46 2.5 6.84 2.69 7.09 3.01L7.91 4.09C8.16 4.41 8.54 4.6 8.95 4.6H13C13.69 4.6 14.25 5.16 14.25 5.85V12.4C14.25 13.09 13.69 13.65 13 13.65H3C2.31 13.65 1.75 13.09 1.75 12.4V3.75Z" fill="currentColor" fill-opacity="0.1"/></svg>
                    <span>Folders &amp; Ignored</span>
                </button>
                <button id="actions-btn" class="toolbar-btn" title="Settings &amp; Shortcuts" aria-haspopup="dialog" aria-expanded="false" aria-controls="actions-modal">
                    <svg class="toolbar-btn-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.7 1.3-2-.8-.9-2 1.3-.7-.2zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
                    <span>Settings</span>
                </button>
            </div>
        </div>
        <div id="shortcut-legend" class="shortcut-legend" role="note" aria-label="Thumbview shortcuts" hidden>
            <span><kbd>Type</kbd> search</span>
            <span><kbd>Left Ctrl</kbd> + hover: magnify</span>
            <span>Click a line: open there</span>
            <span><kbd id="shortcut-legend-key">F4</kbd> / <kbd>Esc</kbd> back to code</span>
            <button id="shortcut-legend-close" class="shortcut-legend-close" aria-label="Hide shortcuts" title="Hide shortcuts">&times;</button>
        </div>
        <div id="auto-hidden-chip" class="auto-hidden-chip" role="status" hidden>
            <button id="auto-hidden-open" class="auto-hidden-open" title="Show in Folders &amp; Ignored">Folders auto-hidden</button>
            <button id="auto-hidden-close" class="shortcut-legend-close" aria-label="Hide this notice" title="Hide this notice">&times;</button>
        </div>
        <div id="fullscreen-notice" class="fullscreen-notice" role="region" aria-labelledby="fullscreen-notice-text" hidden>
            <span id="fullscreen-notice-text">Thumbview opens fullscreen so code stays readable. Press <kbd id="fullscreen-notice-key">F4</kbd> or open a file to go back.</span>
            <button id="fullscreen-notice-keep" class="notice-btn notice-btn-primary">Got it</button>
            <button id="fullscreen-notice-tab" class="notice-btn">Open as a tab instead</button>
        </div>
    </div>
    <script nonce="${nonce}">
        window.PDF_WORKER_URI = "${pdfWorkerUri}";
        window.PDF_JS_URI = "${pdfJsUri}";
        window.PDF_JS_NONCE = "${nonce}";
    </script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** Text for HTML content and attributes (e.g. the user's key binding label from keybindings.json). */
function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function getNonce(): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let text = "";

    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return text;
}
