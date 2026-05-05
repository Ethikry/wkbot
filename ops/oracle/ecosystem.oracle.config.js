const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

module.exports = {
    apps: [
        {
            name: 'wkbot',
            cwd: repoRoot,
            script: path.join(repoRoot, 'index.js'),
            interpreter: 'node',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            merge_logs: true,
            max_memory_restart: '300M',
            restart_delay: 5000,
            exp_backoff_restart_delay: 200,
            min_uptime: '15s',
            max_restarts: 20,
            kill_timeout: 10000,
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
