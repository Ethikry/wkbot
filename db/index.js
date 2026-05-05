const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { runMigrations } = require('./migrations');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
let dbInstance = null;

function getRaw() {
    if (!dbInstance) throw new Error('Database not initialized — call init() first');
    return dbInstance;
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        getRaw().get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        getRaw().all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        getRaw().run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function close() {
    return new Promise((resolve) => {
        if (!dbInstance) return resolve();
        dbInstance.close(() => { dbInstance = null; resolve(); });
    });
}

async function init() {
    if (dbInstance) return;
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(
            dbPath,
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            (err) => {
                if (err) return reject(err);
                dbInstance = db;
                resolve();
            }
        );
    });
    await new Promise((resolve, reject) => {
        dbInstance.run('PRAGMA journal_mode = WAL;', (err) => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
        dbInstance.run('PRAGMA foreign_keys = ON;', (err) => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
        dbInstance.run('PRAGMA busy_timeout = 5000;', (err) => err ? reject(err) : resolve());
    });
    await runMigrations({ get, all, run });
}

module.exports = { init, get, all, run, close };
