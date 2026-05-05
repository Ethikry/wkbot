const express = require('express');

function startHealthServer({ getStatus } = {}) {
    const port = Number(process.env.HEALTH_PORT) || 3000;
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

    const server = app.listen(port, () => {
        console.log(`Health endpoint listening on :${port}/health`);
    });

    server.on('error', (err) => {
        console.error('[health] failed to start:', err.message);
    });

    return server;
}

module.exports = { startHealthServer };
