const KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isApiKeyFormatValid(apiKey) {
    return typeof apiKey === 'string' && KEY_REGEX.test(apiKey);
}

async function isApiKeyValid(apiKey) {
    if (!isApiKeyFormatValid(apiKey)) return false;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const response = await fetch('https://api.wanikani.com/v2/user', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        return response.ok;
    } catch (err) {
        return false;
    }
}

module.exports = { isApiKeyValid, isApiKeyFormatValid };
