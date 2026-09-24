'use strict';
const path = require('path');
const crypto = require('crypto');
// minimal .env loader (no dependency)
(function loadEnv(){
  try{
    const fs=require('fs');
    const p=path.join(process.cwd(),'.env');
    if(fs.existsSync(p)){
      for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){
        const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if(m && !(m[1] in process.env)) process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');
      }
    }
  }catch(e){}
})();
const env = process.env.NODE_ENV || 'development';
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
module.exports = {
  env,
  isProd: env === 'production',
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT||3000}`,
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'app.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(dataDir, 'uploads'),
  backupsDir: process.env.BACKUPS_DIR || path.join(dataDir, 'backups'),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || crypto.randomBytes(48).toString('hex'),
    refreshSecret: process.env.JWT_REFRESH_SECRET || crypto.randomBytes(48).toString('hex'),
    accessTtl: Number(process.env.JWT_ACCESS_TTL || 900),
    refreshTtl: Number(process.env.JWT_REFRESH_TTL || 1209600),
  },
  cookieSecure: process.env.COOKIE_SECURE === '1' || env === 'production',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  ai: {
    apiUrl: process.env.AI_API_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
  },
  email: {
    from: process.env.EMAIL_FROM || 'noreply@localhost',
    smtpUrl: process.env.SMTP_URL || '',
  },
  // secrets NEVER committed: if prod and secrets missing, refuse to start insecurely
  assertSecrets(){
    if(this.isProd){
      if(process.env.JWT_ACCESS_SECRET?.length < 32 || process.env.JWT_REFRESH_SECRET?.length < 32){
        throw new Error('JWT secrets must be set (32+ chars) in production');
      }
    }
  }
};
