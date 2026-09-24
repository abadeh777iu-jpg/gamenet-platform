'use strict';
module.exports = {
  isatty(){ return false; },
  WriteStream: class WriteStream {
    constructor(){ this.isTTY = false; }
    write(){ return true; }
    on(){ return this; }
  },
  ReadStream: class ReadStream {},
  constants: {},
};
