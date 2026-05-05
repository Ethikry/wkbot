const db = require('../db');
const { decrypt } = require('./crypto');
const { isApiKeyFormatValid } = require('./apikeyTest');

async function tryDecrypt(rawValue) {
    if (rawValue == null) return null;
    try {
        const decrypted = decrypt(rawValue);
        return isApiKeyFormatValid(decrypted) ? decrypted : null;
    } catch {
        return null;
    }
}

async function getApiKeyForUser(userId, preferredGuildId = null) {
    if (preferredGuildId) {
        const guildRow = await db.get(
            `SELECT api_key FROM apikeys
             WHERE user_id = ? AND guild_id = ? AND api_key IS NOT NULL`,
            [userId, preferredGuildId]
        );
        const guildKey = await tryDecrypt(guildRow?.api_key);
        if (guildKey) return guildKey;
    }

    const rows = await db.all(
        `SELECT api_key FROM apikeys WHERE user_id = ? AND api_key IS NOT NULL`,
        [userId]
    );
    for (const row of rows) {
        const key = await tryDecrypt(row.api_key);
        if (key) return key;
    }
    return null;
}

module.exports = { getApiKeyForUser };
