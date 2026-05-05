const db = require('../db');
const { decrypt } = require('./crypto');

async function getApiKeyForUser(userId) {
    const row = await db.get(
        `SELECT api_key FROM apikeys WHERE user_id = ? AND api_key IS NOT NULL LIMIT 1`,
        [userId]
    );
    return row ? decrypt(row.api_key) : null;
}

module.exports = { getApiKeyForUser };
