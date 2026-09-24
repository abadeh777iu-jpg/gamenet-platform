'use strict';
function diskStorage(){ return {}; }
function memoryStorage(){ return {}; }

function parseMultipart(buf, ct){
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  const boundary = m ? (m[1]||m[2]).trim() : null;
  if(!boundary) throw new Error('no boundary');
  const parts = [];
  const b = '--' + boundary;
  let start = buf.indexOf(b);
  while(start !== -1){
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if(headerEnd === -1) break;
    const next = buf.indexOf('\r\n' + b, headerEnd);
    const end = next === -1 ? buf.length : next;
    const header = buf.slice(start + b.length, headerEnd).toString('utf8');
    const body = buf.slice(headerEnd + 4, next === -1 ? end : next);
    const cd = /content-disposition:[^\r\n]*name="([^"]+)";[^\r\n]*filename="([^"]*)"/i.exec(header)
           || /content-disposition:[^\r\n]*filename="([^"]*)";[^\r\n]*name="([^"]+)"/i.exec(header);
    const cl = /content-type:\s*([^\r\n]+)/i.exec(header);
    if(cd && /filename=/i.test(header)){
      const name = cd[1] && !cd[1].includes('/') ? cd[1] : (cd[2] && !String(cd[2]).includes('/') ? cd[2] : cd[1]);
      // normalize: first group may be name
      let fieldName = /name="([^"]+)"/i.exec(header);
      let fileName = /filename="([^"]*)"/i.exec(header);
      if(fieldName && fileName){
        parts.push({ name: fieldName[1], filename: fileName[1], type: cl?cl[1].trim():'application/octet-stream', body });
      }
    } else {
      const n = /name="([^"]+)"/i.exec(header);
      if(n) parts.push({ name: n[1], body });
    }
    if(next === -1) break;
    start = next;
  }
  return {
    get(name){
      const p = parts.find(x => x.name === name && x.filename !== undefined);
      const f = parts.find(x => x.name === name);
      const pick = p || f;
      if(!pick) return null;
      if(pick.filename !== undefined){
        return {
          name: pick.filename,
          type: pick.type || 'application/octet-stream',
          arrayBuffer: async () => pick.body.buffer.slice(pick.body.byteOffset, pick.body.byteOffset + pick.body.byteLength),
        };
      }
      return pick.body.toString('utf8');
    },
  };
}

function multer(opts={}){
  const limit = (opts.limits && opts.limits.fileSize) || 25*1024*1024;
  return {
    single(field){
      return async (req, res, next) => {
        try{
          const ct = req.headers['content-type'] || '';
          if(!ct.includes('multipart/form-data')) return next();
          let buf = req.rawBody;
          if(!buf && typeof req.arrayBuffer === 'function'){
            buf = Buffer.from(await req.arrayBuffer());
          }
          if(!buf) return next();
          const formData = parseMultipart(buf, ct);
          const f = formData.get(field);
          if(!f || typeof f === 'string') return next();
          const ab = await f.arrayBuffer();
          const size = ab.byteLength;
          if(size > limit){
            const e = new Error('File too large'); e.status = 413; return next(e);
          }
          const base = Date.now() + '-' + Math.random().toString(36).slice(2,8);
          req.file = {
            fieldname: field,
            originalname: f.name || 'file',
            filename: base + (f.name && f.name.includes('.') ? '.' + f.name.split('.').pop() : ''),
            size,
            buffer: Buffer.from(ab),
            path: '', // buffer mode — no disk
            mimetype: f.type || 'application/octet-stream',
          };
          next();
        }catch(e){ next(e); }
      };
    },
  };
}
module.exports = multer;
module.exports.default = multer;
module.exports.diskStorage = diskStorage;
module.exports.memoryStorage = memoryStorage;
