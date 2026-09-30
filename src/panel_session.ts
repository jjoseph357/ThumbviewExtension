// Bookkeeping around the Thumbview panel's visibility, as a small state machine: when editor-state
// updates to the webview (openState) are held, and when the split-editor return point is recorded
// or dropped. Returns decisions for extension.ts to carry out, so every rule is unit tested.

export interface ViewStateChange {
    visible: boolean;
    active: boolean;
    /** A Thumbview layout sequence (open, close, jump) is running and caused this change. */
    layoutOpInFlight: boolean;
}

export interface ViewStateActions {
    /** Editor-state updates were held and must be sent again now. */
    releaseHold: boolean;
    /** Record where the user came from (they returned by tab click or Ctrl+Tab, not F4). */
    recordReturnPoint: boolean;
    /** The user left Thumbview on their own; an older return point would be stale. */
    clearReturnPoint: boolean;
}

export class PanelSession {
    private held = false;

    /** openState posts are skipped while a file opens over Thumbview. */
    get openStateHeld(): boolean {
        return this.held;
    }

    /** A file is opening over Thumbview (jump or switchTab): hold updates until it is shown again. */
    switchStarted(): void {
        this.held = true;
    }

    /** The open failed, so Thumbview is still in front and its state must flow. */
    switchFailed(): void {
        this.held = false;
    }

    /** A new panel, a reopen, or F4 focusing a visible panel: nothing is held. */
    shown(): void {
        this.held = false;
    }

    viewStateChanged(change: ViewStateChange, hasReturnPoint: boolean): ViewStateActions {
        const actions: ViewStateActions = { releaseHold: false, recordReturnPoint: false, clearReturnPoint: false };
        if (change.visible) {
            // Shown by any route (tab click, Ctrl+Tab, F4): hold released whether or not a layout
            // op is running, so a return during the grace window after a jump is not left stale.
            actions.releaseHold = this.held;
            this.held = false;
            // F4 records the return point before it reveals; any other route has none yet (a jump
            // or a close clears it, and so does leaving on the user's own).
            actions.recordReturnPoint = change.active && !hasReturnPoint;
        } else if (!change.layoutOpInFlight) {
            // Hidden by the user (another tab clicked), not by Thumbview's own close or jump.
            actions.clearReturnPoint = hasReturnPoint;
        }
        return actions;
    }
}
