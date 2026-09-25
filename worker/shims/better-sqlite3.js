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

/** Called by bootstrap before app load; force=true reloads snapshot from KV.
 *  probeVer = the version the caller saw on the db:version key — when the
 *  snapshot embeds a different version we retry briefly (concurrent writers). */
async function __initSqlJs(kvGet, kvPut, force, probeVer){
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
      for(let attempt = 0; attempt < 4; attempt++){
        const raw = await kvGet('db:snapshot');
        let embeddedNv = null;
        if(raw){
          try{
            const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            if(u8.length >= 5 && u8[0] === 0x47 && u8[1] === 0x4e && u8[2] === 0x56 && u8[3] === 0x31 && u8[4] === 0x3a){
              // GNV1:<version>\n<binary sqlite>
              let nl = -1;
              for(let i = 5; i < Math.min(u8.length, 200); i++){
                if(u8[i] === 10){ nl = i; break; }
              }
              if(nl > 5) embeddedNv = String.fromCharCode.apply(null, u8.subarray(5, nl));
              bytes = u8.subarray(nl + 1);
            } else if(u8.length >= 16 && u8[0] === 0x53 && u8[1] === 0x51 && u8[2] === 0x4c && u8[3] === 0x69){
              bytes = u8; // binary snapshot without header
            } else {
              bytes = b64decode(typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(u8) : String.fromCharCode.apply(null, u8)); // legacy base64
            }
          }catch(e){ bytes = null; }
        }
        // Version/content mismatch = a writer's puts landed out of order — wait it out.
        if(!probeVer || !embeddedNv || embeddedNv === String(probeVer) || attempt === 3) break;
        await new Promise(r => setTimeout(r, 150));
      }
    }
    if(sqlDb){
      try{ sqlDb.close(); }catch(e){}
      sqlDb = null;
    }
    sqlDb = bytes ? new SQL.Database(bytes) : new SQL.Database();
    sqlDb.run('PRAGMA foreign_keys = ON;');
    persistHook = async (nv) => {
      if(!kvPut || !dirty) return;
      const data = sqlDb.export(); // Uint8Array — binary KV value, version embedded for atomic pairing
      const ver = String(nv || 'v0');
      const head = new Uint8Array(5 + ver.length + 1);
      head[0] = 0x47; head[1] = 0x4e; head[2] = 0x56; head[3] = 0x31; head[4] = 0x3a; // 'GNV1:'
      for(let i = 0; i < ver.length; i++) head[5 + i] = ver.charCodeAt(i);
      head[5 + ver.length] = 10;
      const blob = new Uint8Array(head.length + data.length);
      blob.set(head, 0);
      blob.set(data, head.length);
      try{
        await kvPut('db:snapshot', blob);
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

async function __flush(nv){
  if(persistHook) await persistHook(nv);
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
