'use strict';
const store = new Map(); // path -> Buffer|string
const dirs = new Set(['/tmp', '/data', process.cwd ? '' : '']);

module.exports = {
  __store: store,
  mkdirSync(p, opts){
    dirs.add(p);
    return undefined;
  },
  existsSync(p){
    if(store.has(p)) return true;
    if(dirs.has(p)) return true;
    // .env never exists on workers
    return false;
  },
  readFileSync(p, enc){
    if(store.has(p)){
      const v = store.get(p);
      if(enc === 'utf8' || typeof enc === 'string') return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      return v;
    }
    throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
  },
  writeFileSync(p, data, opts){
    store.set(p, Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : String(data)));
    return undefined;
  },
  appendFileSync(p, data){
    const prev = store.get(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    store.set(p, prev ? Buffer.concat([Buffer.isBuffer(prev)?prev:Buffer.from(String(prev)), buf]) : buf);
  },
  unlinkSync(p){
    if(!store.has(p)) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
    store.delete(p);
  },
  rmSync(p, opts){
    store.delete(p);
    dirs.delete(p);
  },
  rmdirSync(p){ dirs.delete(p); },
  readdirSync(p){
    const prefix = p.endsWith('/') ? p : p + '/';
    const names = new Set();
    for(const k of store.keys()){
      if(k.startsWith(prefix)){
        const rest = k.slice(prefix.length);
        const seg = rest.split('/')[0];
        if(seg) names.add(seg);
      }
    }
    if(names.size === 0 && !dirs.has(p)){
      throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
    }
    return Array.from(names);
  },
  statSync(p){
    if(store.has(p)){
      const b = store.get(p);
      const size = Buffer.isBuffer(b) ? b.length : String(b).length;
      return { isFile: () => true, isDirectory: () => false, size, mtime: new Date() };
    }
    if(dirs.has(p)) return { isFile: () => false, isDirectory: () => true, size: 0, mtime: new Date() };
    throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
  },
  createReadStream(){ throw new Error('createReadStream n/a on workers'); },
  createWriteStream(){ throw new Error('createWriteStream n/a on workers'); },
  copyFileSync(src, dst){
    if(!store.has(src)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    store.set(dst, store.get(src));
  },
  renameSync(a, b){
    if(!store.has(a)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    store.set(b, store.get(a)); store.delete(a);
  },
  openSync(){ return 0; },
  closeSync(){},
  readSync(){ return 0; },
  writeSync(){ return 0; },
  promises: {},
  constants: { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64 },
  F_OK: 0, R_OK: 4, W_OK: 2,
};
