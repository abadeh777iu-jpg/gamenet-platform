'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./index');

function migrate(){
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const applied = db.prepare('SELECT name FROM _migrations').all().map(r=>r.name);
  if(!applied.includes('001_schema')){
    db.transaction(()=>{ db.exec(sql); db.prepare('INSERT INTO _migrations(name) VALUES(?)').run('001_schema'); })();
    console.log('applied 001_schema');
  }
  // future migrations: add 002_*.sql files here
  console.log('migrations up-to-date');
}

if(require.main === module){ migrate(); }
module.exports = { migrate };
