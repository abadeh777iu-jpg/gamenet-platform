'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./index');

// schema.sql is inlined at build time by esbuild (--loader:.sql=text).
// On plain Node (tests/local), fall back to reading from disk.
function loadSchema(){
  try{
    const embedded = require('./schema.sql');
    if(typeof embedded === 'string' && embedded.length > 0) return embedded;
  }catch(e){ /* not bundled as text */ }
  const candidates = [
    (typeof __dirname !== 'undefined' && path.join(__dirname, 'schema.sql')),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'schema.sql'),
  ].filter(Boolean);
  for(const p of candidates){
    try{ return fs.readFileSync(p, 'utf8'); }catch(e){}
  }
  throw new Error('schema.sql not found');
}

function migrate(){
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const sql = loadSchema();
  const applied = db.prepare('SELECT name FROM _migrations').all().map(r=>r.name);
  if(!applied.includes('001_schema')){
    db.transaction(()=>{ db.exec(sql); db.prepare('INSERT INTO _migrations(name) VALUES(?)').run('001_schema'); })();
    console.log('applied 001_schema');
  }
  console.log('migrations up-to-date');
}

if(typeof require !== 'undefined' && require.main === module){ migrate(); }
module.exports = { migrate };
