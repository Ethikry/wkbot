const util = require('util');

const INSTALLED = Symbol.for('wkbot.logger.installed');
const ORIGINALS = Symbol.for('wkbot.logger.originals');
const SECRET_KEY_PATTERN = /token|api[_-]?key|authorization|password|secret|encryption[_-]?key/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(value) {
    return value.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
}

function redactValue(value, seen = new WeakSet()) {
    if (typeof value === 'string') return redactString(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => redactValue(item, seen));
    }

    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = SECRET_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : redactValue(value[key], seen);
    }
    return out;
}

function extraErrorFields(err) {
    const out = {};
    for (const key of Object.keys(err)) {
        if (key === 'cause' || key === 'errors') continue;
        out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(err[key]);
    }
    if (err.code) out.code = err.code;
    if (err.status) out.status = err.status;
    if (err.statusCode) out.statusCode = err.statusCode;
    return out;
}

function formatError(err, depth = 0) {
    const lines = [redactString(err.stack || `${err.name || 'Error'}: ${err.message || String(err)}`)];
    const extras = extraErrorFields(err);
    if (Object.keys(extras).length) {
        lines.push(`details=${util.inspect(extras, { depth: 5, breakLength: 120, compact: true })}`);
    }
    if (err.cause && depth < 4) {
        lines.push(`cause: ${formatValue(err.cause, depth + 1)}`);
    }
    if (Array.isArray(err.errors) && depth < 4) {
        err.errors.forEach((inner, index) => {
            lines.push(`error[${index}]: ${formatValue(inner, depth + 1)}`);
        });
    }
    return lines.join('\n');
}

function formatValue(value, depth = 0) {
    if (value instanceof Error) return formatError(value, depth);
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'object' && value !== null) {
        return util.inspect(redactValue(value), { depth: 6, breakLength: 120, compact: true });
    }
    return String(value);
}

function formatArgs(args) {
    if (args.length === 0) return '';
    if (typeof args[0] === 'string' && /%[sdifoOj%]/.test(args[0])) {
        return redactString(util.format(...args));
    }
    return args.map(arg => formatValue(arg)).join(' ');
}

function write(original, level, args) {
    const prefix = `[${new Date().toISOString()}] [${level}] `;
    const message = formatArgs(args);
    original(message.split('\n').map(line => `${prefix}${line}`).join('\n'));
}

function installConsoleLogger() {
    if (console[INSTALLED]) return;
    const originals = {
        debug: console.debug.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        log: console.log.bind(console),
        warn: console.warn.bind(console),
    };
    Object.defineProperty(console, ORIGINALS, { value: originals });
    console.debug = (...args) => write(originals.debug, 'DEBUG', args);
    console.error = (...args) => write(originals.error, 'ERROR', args);
    console.info = (...args) => write(originals.info, 'INFO', args);
    console.log = (...args) => write(originals.log, 'INFO', args);
    console.warn = (...args) => write(originals.warn, 'WARN', args);
    Object.defineProperty(console, INSTALLED, { value: true });
}

function createLogger(scope) {
    const prefix = scope ? `[${scope}]` : null;
    const withScope = args => (prefix ? [prefix, ...args] : args);
    return {
        debug: (...args) => console.debug(...withScope(args)),
        error: (...args) => console.error(...withScope(args)),
        info: (...args) => console.info(...withScope(args)),
        warn: (...args) => console.warn(...withScope(args)),
    };
}

module.exports = {
    createLogger,
    installConsoleLogger,
    formatArgs,
};
