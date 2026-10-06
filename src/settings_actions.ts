// Settings, ignore-pattern, and one-time-notice actions requested from Thumbview's toolbar and
// settings dialog. Returns a table of handlers by webview command name; extension.ts dispatches
// to it. Values sent by the page are validated or clamped before they reach user settings.
import * as vscode from "vscode";
import { clearScanCache, type ScanIgnoreState } from "./scanner";

// globalState keys for the one-time fullscreen banner and the dismissible shortcut legend.
export const FULLSCREEN_NOTICE_KEY = "thumbview.fullscreenNoticeShown";
export const SHORTCUT_LEGEND_DISMISSED_KEY = "thumbview.shortcutLegendDismissed";
/** workspaceState: folders auto-ignore added (extension.ts persistIgnoreState). */
export const AUTO_IGNORED_FOLDERS_KEY = "thumbview.autoIgnoredFolders";
/** workspaceState: the auto-hidden set the user dismissed the chip for; a different set shows it again. */
export const AUTO_HIDDEN_DISMISSED_KEY = "thumbview.autoHiddenChipDismissed";
/** Confirmations whose effect is visible or trivial go to the status bar, not a notification. */
export const STATUS_MESSAGE_MS = 3000;

/** What the actions need from extension.ts. `host.activePanel` is read at call time (it changes). */
export interface SettingsActionHost {
    readonly context: vscode.ExtensionContext;
    readonly activePanel: vscode.WebviewPanel | undefined;
    refreshThumbview(panel: vscode.WebviewPanel): Promise<void>;
    updateLayoutFromCache(panel: vscode.WebviewPanel): Promise<void>;
    getIgnoreState(): ScanIgnoreState;
    persistIgnoreState(state: ScanIgnoreState): Promise<void>;
    refreshProviders(): void;
    isFullscreenOnOpen(): boolean;
    /** Spanning placements depend on the compression setting; drop them when it changes. */
    forgetSpanningPlacements(): void;
}

export type SettingsActionHandler = (msg: any) => Promise<void>;

export function createSettingsActions(host: SettingsActionHost): Record<string, SettingsActionHandler> {
    const { context, refreshThumbview, updateLayoutFromCache, getIgnoreState, persistIgnoreState, refreshProviders, isFullscreenOnOpen } = host;

    return {
        dismissShortcutLegend: async (msg: any) => {
            await context.globalState.update(SHORTCUT_LEGEND_DISMISSED_KEY, true);
            return;
        },
        // Fields: { signature: string } (overview.js autoHiddenSignature of the folders shown).
        dismissAutoHiddenChip: async (msg: any) => {
            if (typeof msg.signature === "string" && msg.signature.length <= 100_000) {
                await context.workspaceState.update(AUTO_HIDDEN_DISMISSED_KEY, msg.signature);
            }
            return;
        },
        dismissFullscreenNotice: async (msg: any) => {
            await context.globalState.update(FULLSCREEN_NOTICE_KEY, true);
            return;
        },
        setFullscreenOnOpen: async (msg: any) => {
            await context.globalState.update(FULLSCREEN_NOTICE_KEY, true);
            try {
                await vscode.workspace.getConfiguration("thumbview").update("fullscreenOnOpen", !!msg.enabled, vscode.ConfigurationTarget.Global);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to change fullscreen setting: ${err?.message ?? String(err)}`);
                host.activePanel?.webview.postMessage({ command: "fullscreenSetting", enabled: isFullscreenOnOpen() });
            }
            return;
        },
        setDragReorderMode: async (msg: any) => {
            try {
                const config = vscode.workspace.getConfiguration("thumbview");
                if (msg.mode !== "swap" && msg.mode !== "shift") {
                    return;
                }
                await config.update("dragReorderMode", msg.mode, vscode.ConfigurationTarget.Global);
                const modeStr = !msg.mode ? "" : msg.mode.charAt(0).toUpperCase() + msg.mode.slice(1);
                vscode.window.setStatusBarMessage(`Thumbview Drag Reorder Mode set to ${modeStr}.`, STATUS_MESSAGE_MS);
                if (host.activePanel) {
                    updateLayoutFromCache(host.activePanel);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set drag reorder mode: ${err?.message ?? String(err)}`);
            }
        },
        setLayoutMode: async (msg: any) => {
            try {
                const config = vscode.workspace.getConfiguration("thumbview");
                if (msg.mode !== "uniform_grid" && msg.mode !== "spanning_grid") {
                    return;
                }
                await config.update("layoutMode", msg.mode, vscode.ConfigurationTarget.Global);
                if (host.activePanel) {
                    refreshThumbview(host.activePanel);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set layout mode: ${err?.message ?? String(err)}`);
            }
        },
        setRenderMediaThumbnails: async (msg: any) => {
            try {
                const config = vscode.workspace.getConfiguration("thumbview");
                await config.update("renderMediaThumbnails", !!msg.enabled, vscode.ConfigurationTarget.Global);
                if (host.activePanel) {
                    refreshThumbview(host.activePanel);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set media thumbnails: ${err?.message ?? String(err)}`);
            }
        },
        setCompressionPercentage: async (msg: any) => {
            try {
                const val = Math.max(0, Math.min(25, Math.round(Number(msg.value) || 0)));
                const config = vscode.workspace.getConfiguration("thumbview");
                await context.workspaceState.update("thumbview.spanningRows", undefined);
                await context.workspaceState.update("thumbview.spanningAllocations", undefined);
                host.forgetSpanningPlacements();
                await config.update("compressionPercentage", val, vscode.ConfigurationTarget.Global);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set compression percentage: ${err?.message ?? String(err)}`);
            }
        },
        setMinCellDimensions: async (msg: any) => {
            try {
                const w = Math.max(10, Math.min(500, Math.round(Number(msg.minCellWidth) || 40)));
                const h = Math.max(10, Math.min(500, Math.round(Number(msg.minCellHeight) || 28)));
                const config = vscode.workspace.getConfiguration("thumbview");
                await config.update("minCellWidth", w, vscode.ConfigurationTarget.Global);
                await config.update("minCellHeight", h, vscode.ConfigurationTarget.Global);
                if (host.activePanel) {
                    refreshThumbview(host.activePanel);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set tile collapse dimensions: ${err?.message ?? String(err)}`);
            }
        },
        setAutoIgnoreThreshold: async (msg: any) => {
            try {
                const val = Math.max(0, Math.round(Number(msg.threshold) || 0));
                const config = vscode.workspace.getConfiguration("thumbview");
                await config.update("autoIgnoreThreshold", val, vscode.ConfigurationTarget.Global);
                clearScanCache();
                if (host.activePanel) {
                    refreshThumbview(host.activePanel);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to set auto-ignore threshold: ${err?.message ?? String(err)}`);
            }
        },
        addIgnorePattern: async (msg: any) => {
            try {
                const pattern = (msg.pattern || "").replace(/\\/g, "/").trim();
                if (pattern) {
                    const state = getIgnoreState();
                    const cleanPattern = pattern.replace(/\/+$/, "");
                    const exists = state.ignorePatterns.some(p => p === pattern || p.replace(/\/+$/, "") === cleanPattern);
                    if (!exists) {
                        await persistIgnoreState({ ...state, ignorePatterns: [pattern, ...state.ignorePatterns] });
                        vscode.window.showInformationMessage(`Added '${pattern}' to ignore list.`);
                        refreshProviders();
                    }
                    if (host.activePanel) {
                        await updateLayoutFromCache(host.activePanel);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to add ignore pattern: ${err?.message ?? String(err)}`);
            }
        },
        removeIgnorePattern: async (msg: any) => {
            try {
                const pattern = (msg.pattern || "").trim();
                if (pattern) {
                    const state = getIgnoreState();
                    const cleanPattern = pattern.replace(/\/+$/, "");
                    const updatedPatterns = state.ignorePatterns.filter(p => p !== pattern && p.replace(/\/+$/, "") !== cleanPattern);
                    const updatedExclusions = [...state.autoIgnoreExclusions];
                    if (!updatedExclusions.some(p => p === pattern || p.replace(/\/+$/, "") === cleanPattern)) {
                        updatedExclusions.push(pattern);
                    }
                    await persistIgnoreState({ ignorePatterns: updatedPatterns, autoIgnoreExclusions: updatedExclusions });
                    vscode.window.showInformationMessage(`Unignored '${pattern}'.`);
                    refreshProviders();
                    if (host.activePanel) {
                        await refreshThumbview(host.activePanel);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to remove ignore pattern: ${err?.message ?? String(err)}`);
            }
        },
        configureHotkey: async (msg: any) => {
            vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "thumbview.open");
        },
        studyStatus: async (msg: any) => {
            await vscode.commands.executeCommand("thumbview.study.info");
        },
        setParticipantId: async (msg: any) => {
            const rawId = typeof msg.participantId === "string" ? msg.participantId.trim() : "";
            if (!rawId) {
                vscode.window.showWarningMessage("Please enter a valid Participant ID.");
                return;
            }
            await vscode.commands.executeCommand("thumbview.study.setParticipantId", rawId);
        },
    };
}
