const db = require('../db');
const { decrypt } = require('./crypto');
const { isApiKeyFormatValid } = require('./apikeyTest');

async function getAccountForDiscordUser(discordUserId) {
    return db.get(
        `SELECT * FROM wanikani_accounts WHERE discord_user_id = ?`,
        [discordUserId]
    );
}

async function getDecryptedToken(discordUserId) {
    const account = await getAccountForDiscordUser(discordUserId);
    if (!account?.api_token_encrypted) return null;
    try {
        const token = decrypt(account.api_token_encrypted);
        return isApiKeyFormatValid(token) ? token : null;
    } catch {
        return null;
    }
}

async function getWanikaniUserId(discordUserId) {
    const account = await getAccountForDiscordUser(discordUserId);
    return account?.wanikani_user_id ?? null;
}

module.exports = { getAccountForDiscordUser, getDecryptedToken, getWanikaniUserId };
