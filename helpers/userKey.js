const { getDecryptedToken } = require('./userLink');

// preferredGuildId is unused — tokens are now global per Discord user.
async function getApiKeyForUser(userId, _preferredGuildId = null) {
    return getDecryptedToken(userId);
}

module.exports = { getApiKeyForUser };
