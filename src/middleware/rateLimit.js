'use strict';
/** In-memory sliding window limiter (replace with Redis at scale). */
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 60, keyFn } = {}){
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : (req.ip + '|' + (req.baseUrl + req.path)));
    const now = Date.now();
    let arr = buckets.get(key) || [];
    arr = arr.filter(t => now - t < windowMs);
    if(arr.length >= max){
      res.setHeader('Retry-After', Math.ceil(windowMs/1000));
      return res.status(429).json({ error: 'rate_limited', message: 'تعداد درخواست‌ها زیاد است. کمی صبر کنید.' });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}
// periodic cleanup
setInterval(()=>{
  const now = Date.now();
  for(const [k,v] of buckets){
    if(!v.length || now - v[v.length-1] > 300000) buckets.delete(k);
  }
}, 60000).unref?.();
module.exports = { rateLimit };
