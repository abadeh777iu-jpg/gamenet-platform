'use strict';
// workerd has no location — sql.js reads self.location.href at module load
try{
  if(typeof globalThis.location === 'undefined' || !globalThis.location || !globalThis.location.href){
    Object.defineProperty(globalThis, 'location', {
      value: {
        href: 'https://gamenet-platform.pages.dev/assets/',
        origin: 'https://gamenet-platform.pages.dev',
        pathname: '/assets/',
        search: '',
        hash: '',
        protocol: 'https:',
        host: 'gamenet-platform.pages.dev',
        hostname: 'gamenet-platform.pages.dev',
        port: '',
      },
      configurable: true,
      writable: true,
    });
  }
}catch(e){}
// Pure-JS SQLite (asm.js) — Cloudflare disallows runtime WebAssembly.instantiate
const initSqlJs = require('../vendor/sql-asm.js');

let SQL = null;
let sqlDb = null;
let persistHook = null;
let dirty = false;
let initPromise = null;
let txDepth = 0; // connection-level transaction nesting depth

function b64encode(bytes){
  let bin = '';
  const chunk = 0x8000;
  for(let i=0;i<bytes.length;i+=chunk){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
  }
  return btoa(bin);
}
function b64decode(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Called by bootstrap before app load; force=true reloads snapshot from KV */
async function __initSqlJs(kvGet, kvPut, force){
  if(initPromise && !force) return initPromise;
  if(force){
    initPromise = null;
    dirty = false;
  }
  initPromise = (async () => {
    // asm.js build: no wasm fetch, no WebAssembly
    if(!SQL) SQL = await initSqlJs({});
    let bytes = null;
    if(kvGet){
      const raw = await kvGet('db:snapshot');
      if(raw){
        try{
          if(typeof raw === 'string'){
            bytes = b64decode(raw); // legacy base64 snapshots
          } else {
            const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            // 'SQLite format 3\0' header → binary snapshot; otherwise legacy base64 text
            if(u8.length >= 16 && u8[0] === 0x53 && u8[1] === 0x51 && u8[2] === 0x4c && u8[3] === 0x69){
              bytes = u8;
            } else {
              bytes = b64decode(typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(u8) : String.fromCharCode.apply(null, u8));
            }
          }
        }catch(e){ bytes = null; }
      }
    }
    if(sqlDb){
      try{ sqlDb.close(); }catch(e){}
      sqlDb = null;
    }
    sqlDb = bytes ? new SQL.Database(bytes) : new SQL.Database();
    sqlDb.run('PRAGMA foreign_keys = ON;');
    persistHook = async () => {
      if(!kvPut || !dirty) return;
      const data = sqlDb.export(); // Uint8Array — stored as binary KV value (no base64 tax)
      try{
        await kvPut('db:snapshot', data);
        dirty = false; // only clear after the snapshot is durably stored
      }catch(e){
        dirty = true; // keep dirty so the next flush retries — never lose writes
        throw e;
      }
    };
    return true;
  })();
  return initPromise;
}

async function __flush(){
  if(persistHook) await persistHook();
}

function lastInsertId(){
  try{
    const r = sqlDb.exec('SELECT last_insert_rowid()');
    if(r[0] && r[0].values[0]) return Number(r[0].values[0][0]);
  }catch(e){}
  return 0;
}

class Statement {
  constructor(sql){ this.sql = sql; }
  _bindAndRun(params){
    const db = sqlDb;
    if(!db) throw new Error('db not ready');
    const stmt = db.prepare(this.sql);
    try{
      if(params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array) && !(Buffer.isBuffer && Buffer.isBuffer(params[0]))){
        const obj = params[0];
        if(this.sql.includes('?')){
          stmt.bind(Object.values(obj));
        } else {
          stmt.bind(obj);
        }
      } else if(params.length){
        // coerce booleans/undefined for sqlite
        const norm = params.map(p => {
          if(p === undefined) return null;
          if(typeof p === 'boolean') return p ? 1 : 0;
          return p;
        });
        stmt.bind(norm);
      }
      return stmt;
    } catch(e){
      stmt.free();
      throw e;
    }
  }
  run(...params){
    const stmt = this._bindAndRun(params);
    try{
      while(stmt.step()){}
      const changes = sqlDb.getRowsModified();
      const isInsert = /^\s*INSERT/i.test(this.sql);
      const lastId = isInsert ? lastInsertId() : 0;
      dirty = true;
      return { changes, lastInsertRowid: lastId };
    } finally { stmt.free(); }
  }
  get(...params){
    const stmt = this._bindAndRun(params);
    try{
      if(stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally { stmt.free(); }
  }
  all(...params){
    const stmt = this._bindAndRun(params);
    const rows = [];
    try{
      while(stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }
}

class Database {
  constructor(){
    // sqlDb must be initialized via __initSqlJs before first query;
    // if not, lazy-init empty (tests/local may not use this path)
    if(!sqlDb && SQL){
      sqlDb = new SQL.Database();
      sqlDb.run('PRAGMA foreign_keys = ON;');
    }
  }
  prepare(sql){ return new Statement(sql); }
  exec(sql){
    if(!sqlDb) throw new Error('db not ready — call __initSqlJs first');
    sqlDb.run(sql);
    dirty = true;
    return this;
  }
  pragma(s){
    if(!sqlDb) return undefined;
    try{ sqlDb.run('PRAGMA ' + s); }catch(e){}
    return this;
  }
  transaction(fn){
    const self = this;
    // txDepth is CONNECTION-level (module scope): nested tx() calls from
    // different service functions share one SQLite connection and must use
    // savepoints, otherwise SQLite throws "cannot start a transaction within a transaction".
    return function(...args){
      const savepoint = 'sp_' + (Math.random().toString(36).slice(2,10));
      if(txDepth === 0){
        sqlDb.run('BEGIN');
      } else {
        sqlDb.run('SAVEPOINT ' + savepoint);
      }
      txDepth++;
      try{
        const r = fn.apply(self, args);
        txDepth--;
        if(txDepth === 0){
          sqlDb.run('COMMIT');
        } else {
          sqlDb.run('RELEASE ' + savepoint);
        }
        dirty = true;
        return r;
      } catch(e){
        txDepth--;
        try{
          if(txDepth === 0){
            sqlDb.run('ROLLBACK');
          } else {
            sqlDb.run('ROLLBACK TO ' + savepoint);
            sqlDb.run('RELEASE ' + savepoint);
          }
        } catch(e2){}
        throw e;
      }
    };
  }
  close(){ /* keep open for isolate lifetime */ return this; }
}

Database.__initSqlJs = __initSqlJs;
Database.__flush = __flush;
Database.__isSqlJs = true;
module.exports = Database;
