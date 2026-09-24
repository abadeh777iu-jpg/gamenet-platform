'use strict';
const { EventEmitter } = require('events');
const { Readable, Writable } = (() => {
  // avoid circular: define minimal streams here via EventEmitter
  return {};
})();

function IncomingMessage(socket){
  EventEmitter.call(this);
  this.socket = socket || { encrypted: false, remoteAddress: '0.0.0.0' };
  this.connection = this.socket;
  this.headers = {};
  this.rawHeaders = [];
  this.trailers = {};
  this.rawTrailers = [];
  this.httpVersion = '1.1';
  this.httpVersionMajor = 1;
  this.httpVersionMinor = 1;
  this.method = 'GET';
  this.url = '/';
  this.statusCode = null;
  this.statusMessage = null;
  this.complete = false;
  this.readable = true;
}
IncomingMessage.prototype = Object.create(EventEmitter.prototype);
IncomingMessage.prototype.constructor = IncomingMessage;
IncomingMessage.prototype.setEncoding = function(){ return this; };
IncomingMessage.prototype.pause = function(){ this.emit('pause'); return this; };
IncomingMessage.prototype.resume = function(){ this.emit('resume'); return this; };
IncomingMessage.prototype.read = function(){ return null; };
IncomingMessage.prototype._read = function(){};

function ServerResponse(request){
  EventEmitter.call(this);
  this.req = request;
  this.statusCode = 200;
  this.statusMessage = undefined;
  this.headers = {};
  this.sendDate = true;
  this.chunkedEncoding = false;
  this.shouldKeepAlive = false;
  this._header = null;
  this._headers = {};
  this._sent100 = false;
  this.writable = true;
}
ServerResponse.prototype = Object.create(EventEmitter.prototype);
ServerResponse.prototype.constructor = ServerResponse;
ServerResponse.prototype.setHeader = function(name, value){
  const key = String(name).toLowerCase();
  this._headers[key] = { name: String(name), value };
  return this;
};
ServerResponse.prototype.getHeader = function(name){
  const h = this._headers[String(name).toLowerCase()];
  return h ? h.value : undefined;
};
ServerResponse.prototype.getHeaders = function(){
  const o = {};
  for(const k of Object.keys(this._headers)) o[k] = this._headers[k].value;
  return o;
};
ServerResponse.prototype.removeHeader = function(name){
  delete this._headers[String(name).toLowerCase()];
};
ServerResponse.prototype.hasHeader = function(name){
  return Object.prototype.hasOwnProperty.call(this._headers, String(name).toLowerCase());
};
ServerResponse.prototype.flushHeaders = function(){};
ServerResponse.prototype.write = function(chunk, enc, cb){
  if(typeof enc === 'function'){ cb = enc; }
  if(cb) cb();
  return true;
};
ServerResponse.prototype.end = function(chunk, enc, cb){
  if(typeof chunk === 'function'){ cb = chunk; }
  else if(typeof enc === 'function'){ cb = enc; }
  this.writable = false;
  this.finished = true;
  this.emit('finish');
  if(cb) cb();
  return this;
};
ServerResponse.prototype.writeContinue = function(){};
ServerResponse.prototype.writeHead = function(code, reason, headers){
  this.statusCode = code;
  if(typeof reason === 'object' && reason){ headers = reason; }
  if(headers) for(const [k,v] of Object.entries(headers)) this.setHeader(k, v);
  return this;
};
ServerResponse.prototype.setTimeout = function(ms, cb){
  if(cb) this.once('timeout', cb);
  return this;
};
ServerResponse.prototype.writeHeader = ServerResponse.prototype.writeHead;

function Server(){ EventEmitter.call(this); }
Server.prototype = Object.create(EventEmitter.prototype);
Server.prototype.constructor = Server;
Server.prototype.listen = function(){ return this; };
Server.prototype.close = function(cb){ if(cb) cb(); return this; };

function ClientRequest(){ EventEmitter.call(this); }
ClientRequest.prototype = Object.create(EventEmitter.prototype);
ClientRequest.prototype.constructor = ClientRequest;
ClientRequest.prototype.setTimeout = function(){ return this; };
ClientRequest.prototype.abort = function(){ this.emit('abort'); };
ClientRequest.prototype.destroy = function(){ this.emit('close'); };

function createServer(requestListener){
  const s = new Server();
  if(requestListener) s.on('request', requestListener);
  return s;
}

function request(){ return new ClientRequest(); }
function get(){ const r = new ClientRequest(); r.end(); return r; }

module.exports = {
  IncomingMessage,
  ServerResponse,
  Server,
  ClientRequest,
  createServer,
  request,
  get,
  METHODS: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'],
  STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' },
  globalAgent: {},
  Agent: class Agent {},
  maxHeaderSize: 16384,
  validateHeaderName(){ return true; },
  validateHeaderValue(){ return true; },
};
