'use strict';
// Neutralize depd/deprecate wrappers that use new Function (blocked on Workers)
function deprecate(fn, msg){ return typeof fn === 'function' ? fn : function(){}; }
deprecate.wrapfunction = function(fn, msg){ return typeof fn === 'function' ? fn : function(){}; };
deprecate._verbose = false;
module.exports = deprecate;
