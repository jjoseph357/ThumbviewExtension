// Concurrency helpers for extension.ts: a re-entrant promise-queue lock with a watchdog, and a
// key-press toggle that coalesces presses arriving while a toggle is still running.
import { AsyncLocalStorage } from "async_hooks";

// A layout sequence that has not settled after this long is assumed hung (e.g. a workbench
// command that never resolves while the GPU process is struggling). The queue moves on so the
// next F4 press still works; the hung task may still finish later.
export const LOCK_WATCHDOG_MS = 5000;

export interface ReentrantLock {
    <T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Runs `fn` outside this lock's ownership. Timers created inside a locked task inherit the
     * AsyncLocalStorage context and would otherwise think they hold the lock and bypass the queue.
     */
    exit<T>(fn: () => T): T;
}

function withWatchdog<T>(task: Promise<T>, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
    });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A promise queue that runs one task at a time. Re-entrant through AsyncLocalStorage: a task that
 * already holds the lock and calls another locked function runs it inline instead of deadlocking.
 */
export function createReentrantLock(timeoutMs: number = LOCK_WATCHDOG_MS): ReentrantLock {
    const held = new AsyncLocalStorage<boolean>();
    let chain: Promise<unknown> = Promise.resolve();
    const lock = (<T>(fn: () => Promise<T>): Promise<T> => {
        if (held.getStore()) {
            return fn();
        }
        const run = chain.then(() => held.run(true, fn));
        chain = withWatchdog(run, timeoutMs).catch(() => {});
        return run;
    }) as ReentrantLock;
    lock.exit = <T>(fn: () => T): T => held.exit(fn);
    return lock;
}

/**
 * Wraps a toggle so presses that arrive while one is running are coalesced by parity: an even
 * number cancels out, an odd number runs exactly one more toggle after the current one. Spamming
 * the key therefore never queues a burst of toggles. A toggle that hangs past the watchdog stops
 * blocking later presses.
 */
export function createCoalescedToggle(
    toggle: () => Promise<void>,
    lock: <T>(fn: () => Promise<T>) => Promise<T> = fn => fn(),
    timeoutMs: number = LOCK_WATCHDOG_MS
): () => Promise<void> {
    let running = false;
    let queuedOdd = false;
    return async () => {
        if (running) {
            queuedOdd = !queuedOdd;
            return;
        }
        running = true;
        try {
            await withWatchdog(lock(toggle), timeoutMs);
            while (queuedOdd) {
                queuedOdd = false;
                await withWatchdog(lock(toggle), timeoutMs);
            }
        } finally {
            running = false;
        }
    };
}
