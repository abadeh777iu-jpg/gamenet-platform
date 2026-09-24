'use strict';
const { db } = require('../db');
const config = require('../config');
/** Queue email: SMTP if configured, otherwise outbox row (dev visibility). */
function sendEmail({ to, subject, body }){
  db.prepare(`INSERT INTO outbox_emails(to_email,subject,body) VALUES(?,?,?)`).run(to, subject, body);
  if(config.email.smtpUrl){
    // Future: plug SMTP/Resend via env. Never hardcode providers/secrets.
    // Intentionally left as extension point; status stays queued until worker sends.
  } else {
    console.log(`[email:outbox] to=${to} subject=${subject}`);
  }
}
function flushOutbox(){
  // stub job: mark as sent in dev when no SMTP configured
  if(config.email.smtpUrl) return 0;
  const r = db.prepare(`UPDATE outbox_emails SET status='sent', sent_at=datetime('now') WHERE status='queued'`).run();
  return r.changes;
}
module.exports = { sendEmail, flushOutbox };
