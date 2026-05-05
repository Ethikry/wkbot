const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1:';

let warned = false;

function getKey() {
    const k = process.env.ENCRYPTION_KEY;
    if (!k) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(k)) {
        throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32');
    }
    return Buffer.from(k, 'hex');
}

function warnIfMissing() {
    if (warned) return;
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('[crypto] ENCRYPTION_KEY not set — API keys are stored in plaintext. Set it for at-rest encryption.');
        warned = true;
    }
}

function encrypt(plaintext) {
    if (plaintext == null) return null;
    const key = getKey();
    if (!key) {
        warnIfMissing();
        return plaintext;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload) {
    if (payload == null) return null;
    if (!payload.startsWith(PREFIX)) {
        return payload;
    }
    const key = getKey();
    if (!key) {
        throw new Error('ENCRYPTION_KEY required to decrypt stored API keys');
    }
    const [, ivHex, tagHex, encHex] = payload.split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final(),
    ]);
    return dec.toString('utf8');
}

function isEncrypted(payload) {
    return typeof payload === 'string' && payload.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted, warnIfMissing };
