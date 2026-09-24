'use strict';
const config = require('../config');
function notFound(req, res){
  res.status(404).json({ error:'not_found', message: 'مسیر یافت نشد' });
}
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next){
  const status = err.status || 500;
  const payload = {
    error: err.code || (status===500 ? 'internal_error' : 'error'),
    message: status === 500 && config.isProd ? 'خطای داخلی سرور' : (err.message || 'خطا'),
  };
  if(status === 500){
    console.error('[error]', req.method, req.originalUrl, err);
  }
  res.status(status).json(payload);
}
function asyncHandler(fn){
  return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
}
module.exports = { notFound, errorHandler, asyncHandler };
