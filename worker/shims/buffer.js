'use strict';
// Real buffer comes from nodejs_compat via createRequire in banner
// When bundled, require('buffer') is aliased here; get real via node:buffer
let real;
try {
  // eslint-disable-next-line
  real = require('node:buffer');
} catch (e) {
  real = {};
}
const mod = {};
for (const k of Object.keys(real)) {
  mod[k] = real[k];
}
// Ensure enumerable own props for safer-buffer's for..in + hasOwnProperty
for (const k in real) {
  if (!(k in mod)) mod[k] = real[k];
}
if (typeof mod.Buffer === 'undefined' && typeof Buffer !== 'undefined') {
  mod.Buffer = Buffer;
}
// safer-buffer calls buffer.hasOwnProperty(key) — ensure it exists as own or proto
if (typeof mod.hasOwnProperty !== 'function') {
  mod.hasOwnProperty = function hasOwnProperty(k) {
    return Object.prototype.hasOwnProperty.call(this, k);
  };
}
if (typeof mod.Buffer === 'function' && typeof mod.Buffer.hasOwnProperty !== 'function') {
  try {
    Object.defineProperty(mod.Buffer, 'hasOwnProperty', {
      value: function(k){ return Object.prototype.hasOwnProperty.call(this, k); },
      writable: true, configurable: true
    });
  } catch (e) {}
}
module.exports = mod;
