'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const { securityHeaders, csrfIssue, csrfProtect } = require('./middleware/security');
const { attachUser } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(require('./middleware/security').cors);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());
app.use(csrfIssue);
app.use(attachUser);
app.use(csrfProtect);

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/public'));
app.use('/api/subscriptions', require('./routes/subscription'));
app.use('/api/gamenets', require('./routes/gamenet'));
// Play-session subsystem (live sessions, tariffs, buffet) — add-on for the gamenet panel
app.use('/api/gamenets/:gamenetId/play', require('./routes/play'));
app.use('/api/tickets', require('./routes/ticket'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/notifications', require('./routes/notification'));
app.use('/api/admin', require('./routes/admin'));

// Unmatched /api/* → 404 before static (avoids send/fs on API paths)
app.use('/api', notFound);

// Static frontend
const webDir = path.join((typeof __dirname !== 'undefined' && __dirname) || '.', '..', 'web');
app.use(express.static(webDir, { extensions: ['html'], index: 'index.html' }));

// SPA-ish fallback for known app roots
app.get(['/app','/app/','/admin','/admin/','/plans','/login','/register','/forgot','/reset','/verify'], (req,res,next)=>{
  const page = req.path.replace(/^\//,'').replace(/\/$/,'') + '.html';
  res.sendFile(path.join(webDir, page), err => err ? next() : undefined);
});

app.use(notFound);
app.use(errorHandler);
module.exports = app;
