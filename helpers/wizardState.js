const TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const states = new Map();

function set(userId, data) {
    states.set(userId, { ...data, expiresAt: Date.now() + TTL_MS });
}

function get(userId) {
    const entry = states.get(userId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        states.delete(userId);
        return null;
    }
    return entry;
}

function update(userId, patch) {
    const existing = get(userId);
    if (!existing) {
        set(userId, patch);
        return get(userId);
    }
    set(userId, { ...existing, ...patch });
    return get(userId);
}

function remove(userId) {
    states.delete(userId);
}

const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of states) {
        if (v.expiresAt < now) states.delete(k);
    }
}, CLEANUP_INTERVAL_MS);
if (cleanup.unref) cleanup.unref();

module.exports = { set, get, update, remove };
