/** Keeps the screen awake only while a call is active; browser refusals never block calls. */
export function createScreenWakeLock({navigator, document}) {
    let active = false;
    let generation = 0;
    let lock;
    let pending;

    async function release(sentinel) {
        try {await sentinel?.release();} catch {}
    }

    function acquire() {
        if (!active || document.visibilityState === 'hidden' || !navigator.wakeLock?.request) return Promise.resolve();
        if (lock && !lock.released) return Promise.resolve();
        if (pending) return pending;
        const requestGeneration = generation;
        pending = Promise.resolve().then(() => navigator.wakeLock.request('screen')).then(async sentinel => {
            if (!active || generation !== requestGeneration || document.visibilityState === 'hidden') {
                await release(sentinel);
                return;
            }
            lock = sentinel;
            sentinel.addEventListener('release', () => {if (lock === sentinel) lock = undefined;}, {once: true});
        }).catch(() => {}).finally(() => {
            pending = undefined;
            // A new call may start while the previous call's request is still resolving.
            if (active && generation !== requestGeneration) void acquire();
        });
        return pending;
    }

    const onVisibilityChange = () => acquire();
    document.addEventListener?.('visibilitychange', onVisibilityChange);
    return {
        start() {active = true; return acquire();},
        stop() {
            active = false;
            generation++;
            const sentinel = lock;
            lock = undefined;
            return release(sentinel);
        },
        destroy() {
            document.removeEventListener?.('visibilitychange', onVisibilityChange);
            return this.stop();
        },
    };
}
