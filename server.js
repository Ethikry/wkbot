const express = require('express');
const { installConsoleLogger } = require('./helpers/logger');
installConsoleLogger();

function startHealthServer({ getStatus } = {}) {
    const port = Number(process.env.HEALTH_PORT) || 3000;
    const host = process.env.HEALTH_HOST || '127.0.0.1';
    const app = express();
    const startedAt = Date.now();

    app.get('/health', (_req, res) => {
        const status = typeof getStatus === 'function' ? getStatus() : { discord: 'unknown' };
        res.json({
            status: 'ok',
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            timestamp: new Date().toISOString(),
            ...status,
        });
    });

    app.get('/', (_req, res) => res.redirect('/health'));

    const server = app.listen(port, host, () => {
        console.log(`Health endpoint listening on ${host}:${port}/health`);
    });

    server.on('error', (err) => {
        console.error('[health] failed to start:', err);
    });

    return server;
}

module.exports = { startHealthServer };
