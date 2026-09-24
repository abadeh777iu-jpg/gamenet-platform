'use strict';
// Neutralize depd — its wrap uses `new Function` which Workers forbid
module.exports = function depd(namespace){
  const d = function(fn){ return fn; };
  d.function = function(fn, msg){ return fn; };
  d.property = function(obj, prop, msg){ return obj; };
  d._namespace = namespace;
  return d;
};
