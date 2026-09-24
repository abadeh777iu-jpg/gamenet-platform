'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(config.backupsDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/** Run fn inside a transaction (nested-safe via savepoints in better-sqlite3). */
function tx(fn){ return db.transaction(fn)(); }

function nowIso(){ return new Date().toISOString().replace('T',' ').slice(0,19); }

module.exports = { db, tx, nowIso, config };
