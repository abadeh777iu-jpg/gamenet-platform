'use strict';
const config = require('./config');
config.assertSecrets();
const app = require('./app');
const { migrate } = require('./db/migrate');
const { startJobs } = require('./jobs');

migrate();
// seed plans/admin on boot (idempotent)
require('./db/seed').seed();

const server = app.listen(config.port, '0.0.0.0', ()=>{
  console.log(`GameNet Platform listening on http://0.0.0.0:${config.port} (${config.env})`);
  startJobs();
});
function shutdown(){
  console.log('shutting down...');
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
module.exports = server;
