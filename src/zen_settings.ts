// Applies the zenMode.* overrides Thumbview needs while it is open and restores the user's own
// values afterwards. Returns nothing; state lives in the given memento so a crash can be undone
// on the next activation.

// Zen mode would otherwise go OS-fullscreen, center a narrow layout, hide the activity bar, and
// show tabs beside Thumbview. Split groups are hidden by maximizing Thumbview's group instead.
// Keys a VS Code version does not register are skipped (writing one throws).
export const ZEN_OVERRIDES: ReadonlyArray<[string, unknown]> = [
    ["zenMode.centerLayout", false],
    ["zenMode.fullScreen", false],
    ["zenMode.hideActivityBar", false],
    ["zenMode.hideLineNumbers", false],
    ["zenMode.showTabs", "none"],
];

// { [key]: { value } } of the user's global values before Thumbview changed them (value
// undefined = not set). Present only while overrides are applied.
export const ZEN_BACKUP_KEY = "thumbview.zenSettingsBackup";
// True while Zen mode was entered by Thumbview, so activation after a crash can exit it (VS Code
// restores Zen mode across restarts).
export const ZEN_ENTERED_KEY = "thumbview.zenEnteredByThumbview";

export interface ConfigLike {
    // undefined for a key this VS Code version does not register.
    inspect(key: string): { globalValue?: unknown } | undefined;
    update(key: string, value: unknown, global: true): Thenable<void>;
}

export interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

type ZenBackup = { [key: string]: { value: unknown } };

/**
 * Backs up the user's global zenMode values (once) and writes the overrides that differ. Only
 * registered keys are touched, each write is independent, and failures never throw: entering
 * Zen mode must not depend on a settings write (an unregistered key once aborted it entirely).
 */
export async function applyZenOverrides(config: ConfigLike, memento: MementoLike): Promise<void> {
    const registered = ZEN_OVERRIDES.filter(([key]) => config.inspect(key) !== undefined);
    if (!memento.get<ZenBackup>(ZEN_BACKUP_KEY)) {
        const backup: ZenBackup = {};
        for (const [key] of registered) {
            backup[key] = { value: config.inspect(key)?.globalValue };
        }
        await memento.update(ZEN_BACKUP_KEY, backup);
    }
    await Promise.allSettled(registered
        .filter(([key, value]) => config.inspect(key)?.globalValue !== value)
        .map(([key, value]) => Promise.resolve().then(() => config.update(key, value, true))));
}

/** Restores the backed-up values and clears the backup. Returns false when nothing was applied. */
export async function restoreZenSettings(config: ConfigLike, memento: MementoLike): Promise<boolean> {
    const backup = memento.get<ZenBackup>(ZEN_BACKUP_KEY);
    if (!backup) {
        return false;
    }
    await Promise.allSettled(Object.entries(backup)
        .filter(([key, entry]) => config.inspect(key) !== undefined && config.inspect(key)?.globalValue !== entry.value)
        .map(([key, entry]) => Promise.resolve().then(() => config.update(key, entry.value, true))));
    await memento.update(ZEN_BACKUP_KEY, undefined);
    return true;
}

// Windows share globalState, so the backup is owned by every window currently using the
// overrides, each under its own key `thumbview.zenOwner.<sessionId>` = lastHeartbeatMs. One key
// per window (not one shared map) means two windows claiming at once cannot drop each other's
// entry. Settings are restored only when the last live owner releases them, so a second window's
// startup recovery cannot undo a first window's overrides. An owner whose heartbeat is older than
// ZEN_OWNER_STALE_MS is treated as crashed.
export const ZEN_OWNER_KEY_PREFIX = "thumbview.zenOwner.";
export const ZEN_OWNER_STALE_MS = 90_000;
export const ZEN_OWNER_HEARTBEAT_MS = 30_000;

export interface KeyedMementoLike extends MementoLike {
    keys(): readonly string[];
}

function liveOwnerIds(memento: KeyedMementoLike, now: number): string[] {
    return memento.keys()
        .filter(key => key.startsWith(ZEN_OWNER_KEY_PREFIX))
        .filter(key => {
            const beat = memento.get<number>(key);
            return typeof beat === "number" && now - beat < ZEN_OWNER_STALE_MS;
        })
        .map(key => key.substring(ZEN_OWNER_KEY_PREFIX.length));
}

/** Records (or refreshes) this window as a user of the zen overrides. */
export async function claimZenOwnership(memento: KeyedMementoLike, sessionId: string, now: number): Promise<void> {
    await memento.update(ZEN_OWNER_KEY_PREFIX + sessionId, now);
}

/** True when a window other than `sessionId` is still using the overrides. */
export function hasOtherLiveOwners(memento: KeyedMementoLike, sessionId: string, now: number): boolean {
    return liveOwnerIds(memento, now).some(id => id !== sessionId);
}

/**
 * Removes this window as an owner (and prunes stale owners) and restores the user's settings if
 * no other live window still uses them. Also used for crash recovery at activation, where a
 * crashed owner is simply stale. Returns true when settings were restored.
 */
export async function releaseZenOwnership(config: ConfigLike, memento: KeyedMementoLike, sessionId: string, now: number): Promise<boolean> {
    const live = new Set(liveOwnerIds(memento, now));
    for (const key of memento.keys()) {
        if (!key.startsWith(ZEN_OWNER_KEY_PREFIX)) {
            continue;
        }
        const id = key.substring(ZEN_OWNER_KEY_PREFIX.length);
        if (id === sessionId || !live.has(id)) {
            await memento.update(key, undefined);
        }
    }
    live.delete(sessionId);
    if (live.size > 0) {
        return false;
    }
    return restoreZenSettings(config, memento);
}
