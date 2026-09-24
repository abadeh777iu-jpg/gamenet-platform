'use strict';
const EventEmitter = require('events').EventEmitter;

function Stream(arg){
  EventEmitter.call(this);
  if(typeof arg === 'function') this.pipe(arg);
}
Stream.prototype = Object.create(EventEmitter.prototype);
Stream.prototype.constructor = Stream;
Object.setPrototypeOf(Stream, EventEmitter);
Stream.Readable = function Readable(opts){
  Stream.call(this);
  this._readableState = { objectMode: false, ended: false, flowing: null };
  if(opts && typeof opts.read === 'function') this._read = opts.read;
};
Object.setPrototypeOf(Stream.Readable.prototype, Stream.prototype);
Stream.Readable.prototype.constructor = Stream.Readable;
Object.setPrototypeOf(Stream.Readable, Stream);
Stream.Readable.prototype.read = function(){ return null; };
Stream.Readable.prototype.push = function(){ return true; };
Stream.Readable.prototype.unshift = function(){};
Stream.Readable.prototype.destroy = function(err){ if(err) this.emit('error', err); this.emit('close'); return this; };
Stream.Readable.prototype.pipe = function(dest){ this.emit('pipe', dest); return dest; };
Stream.Readable.prototype.unpipe = function(){ return this; };
Stream.Readable.prototype.resume = function(){ this.emit('resume'); return this; };
Stream.Readable.prototype.pause = function(){ this.emit('pause'); return this; };
Stream.Readable.from = function(){ return new Stream.Readable(); };

Stream.Writable = function Writable(opts){
  Stream.call(this);
  this._writableState = { ended: false, objectMode: false };
  if(opts && typeof opts.write === 'function') this._write = opts.write;
};
Object.setPrototypeOf(Stream.Writable.prototype, Stream.prototype);
Stream.Writable.prototype.constructor = Stream.Writable;
Object.setPrototypeOf(Stream.Writable, Stream);
Stream.Writable.prototype.write = function(chunk, enc, cb){
  if(typeof enc === 'function'){ cb = enc; enc = 'utf8'; }
  if(this._write){ try{ this._write(chunk, enc || 'utf8', cb || function(){}); }catch(e){ if(cb) cb(e); } }
  else if(cb) cb();
  return true;
};
Stream.Writable.prototype.end = function(chunk, enc, cb){
  if(typeof chunk === 'function') cb = chunk;
  else if(typeof enc === 'function') cb = enc;
  this._writableState.ended = true;
  this.emit('finish');
  if(cb) cb();
  return this;
};
Stream.Writable.prototype.destroy = function(){ this.emit('close'); return this; };
Stream.Writable.prototype.cork = function(){};
Stream.Writable.prototype.uncork = function(){};

Stream.Transform = function Transform(opts){
  Stream.Writable.call(this, opts);
  if(opts && typeof opts.transform === 'function') this._transform = opts.transform;
};
Object.setPrototypeOf(Stream.Transform.prototype, Stream.Writable.prototype);
Stream.Transform.prototype.constructor = Stream.Transform;
Object.setPrototypeOf(Stream.Transform, Stream.Writable);
Stream.Transform.prototype._transform = function(chunk, enc, cb){ cb(null, chunk); };
Stream.Transform.prototype.push = function(){ return true; };

Stream.Duplex = Stream.Readable;
Stream.PassThrough = Stream.Transform;
Stream.pipeline = function(){
  const last = arguments[arguments.length - 1];
  if(typeof last === 'function') last();
  return arguments[0];
};
Stream.finished = function(stream, cb){ if(typeof cb === 'function') cb(); return function(){}; };
Stream.addAbortSignal = function(sig){ return sig; };
Stream.default = Stream;
Stream.Stream = Stream;
module.exports = Stream;
