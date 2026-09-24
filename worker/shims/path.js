'use strict';
function join(...parts){ return parts.filter(Boolean).join('/').replace(/\/+/g,'/'); }
function dirname(p){ const s=String(p); const i=s.lastIndexOf('/'); return i<=0?'.':s.slice(0,i); }
function basename(p, ext){ const s=String(p).split('/').pop()||''; return ext && s.endsWith(ext)? s.slice(0,-ext.length): s; }
function extname(p){ const s=basename(p); const i=s.lastIndexOf('.'); return i<=0?'':s.slice(i); }
function normalize(p){
  const s=String(p);
  const abs=s.startsWith('/');
  const out=[];
  for(const part of s.split('/')){
    if(part===''||part==='.') continue;
    if(part==='..'){
      if(out.length && out[out.length-1]!=='..') out.pop();
      else if(!abs) out.push('..');
    } else out.push(part);
  }
  if(abs) return '/' + out.join('/');
  return out.length ? out.join('/') : '.';
}
function isAbsolute(p){ return String(p).startsWith('/'); }
function resolve(...parts){ return join(...parts); }
function relative(from, to){ return normalize(to); }
function parse(p){
  const s=String(p);
  const base=basename(s);
  const i=base.lastIndexOf('.');
  return { root: s.startsWith('/')?'/':'', dir: dirname(s), base, ext: i<=0?'':base.slice(i), name: i<=0?base:base.slice(0,i) };
}
function format(o){ return join(o.dir||o.root||'', (o.name||'')+(o.ext||o.base||'')); }
const sep = '/';
const delimiter = ':';
const posix = { join, dirname, basename, extname, normalize, isAbsolute, resolve, relative, parse, format, sep, delimiter };
module.exports = {
  join, dirname, basename, extname, resolve, normalize, isAbsolute,
  relative, parse, format, sep, delimiter, posix, win32: posix,
};
