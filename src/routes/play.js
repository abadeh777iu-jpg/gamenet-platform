'use strict';
/**
 * Play-session API — mounted at /api/gamenets/:gamenetId/play
 * Security model:
 *  - requireAuth + requireTenant → strict tenant isolation (existing middleware)
 *  - session start/stop/pause/resume & buffet-on-session: any member (owner/staff)
 *  - catalog mutations (systems, tariffs, holidays, buffet items): owner only
 *  - ALL duration/cost/status transitions computed & validated server-side;
 *    client-sent amounts/times are ignored by design.
 */
const express = require('express');
const { db, tx, nowIso } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireTenant, requireTenantOwner } = require('../middleware/rbac');
const { asyncHandler } = require('../middleware/errorHandler');
const { rateLimit } = require('../middleware/rateLimit');
const { audit } = require('../services/audit');
const {
  SYSTEM_TYPES, SYSTEM_STATUSES, MANUAL_SYSTEM_STATUSES,
  costFor, elapsedSec, matchTariff, sessionView, openSession,
  liveOverview, dashboardStats, utcMs, hms, storageSummary,
} = require('../services/play');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireTenant('gamenetId'));

/**
 * Owner decision: nothing in the play subsystem may be used before a license
 * is active for this gamenet (issued by subscription purchase OR an admin
 * license event). Read AND write endpoints are all behind this gate.
 */
function hasActiveLicense(gamenetId){
  return !!db.prepare(`
    SELECT id FROM licenses
    WHERE gamenet_id=? AND status='active'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    LIMIT 1`).get(gamenetId);
}
router.use((req, res, next) => {
  if(!hasActiveLicense(req.gamenet.id)){
    return res.status(403).json({
      error: 'license_required',
      message: 'لایسنس فعال نشده است — برای استفاده از سیستم بازی، تعرفه، بوفه و فاکتورها ابتدا باید لایسنس گیم‌نت شما فعال شود.',
    });
  }
  next();
});

router.use(rateLimit({ windowMs: 60000, max: 400 }));

const err400 = (error, message) => Object.assign(new Error(message), { status: 400, publicMessage: message, code: error });
const err409 = (error, message) => Object.assign(new Error(message), { status: 409, publicMessage: message, code: error });
const actorMeta = req => ({ actorUserId: req.user.id, actorRole: req.user.roles.join(','), gamenetId: req.gamenet.id, ip: req.ip });
const str = (v, max=120) => String(v == null ? '' : v).trim().slice(0, max);

/* ─────────────────────────  LIVE SESSIONS  ───────────────────────── */

router.get('/live', asyncHandler(async (req, res) => {
  const nowMs = Date.now();
  const buffet = db.prepare(
    `SELECT id,name,price_cents,stock,active FROM buffet_items WHERE gamenet_id=? AND active=1 ORDER BY name`
  ).all(req.gamenet.id);
  const hasTariff = db.prepare(`SELECT 1 FROM tariffs WHERE gamenet_id=? AND active=1 LIMIT 1`).get(req.gamenet.id);
  const systems = liveOverview(req.gamenet.id, nowMs);
  const lineStmt = db.prepare(
    `SELECT id,item_name,qty,unit_price_cents,line_total_cents FROM session_buffet_lines WHERE session_id=? ORDER BY id`
  );
  for(const sys of systems){
    if(sys.open_session) sys.open_session.lines = lineStmt.all(sys.open_session.id);
  }
  res.json({
    server_now: nowMs,
    server_now_iso: nowIso(),
    systems,
    buffet,
    has_tariff: !!hasTariff,
    member_role: req.tenantAccess === 'platform' ? 'owner' : (req.member ? req.member.member_role : 'staff'),
  });
}));

router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(dashboardStats(req.gamenet.id));
}));

/**
 * Repurposed storage view: quota covers persisted SETTINGS + GAME INVOICES
 * (owner decision — customer file uploads are not part of the gamenet panel).
 */
router.get('/storage', asyncHandler(async (req, res) => {
  const s = storageSummary(req.gamenet.id);
  const invoices = db.prepare(`
    SELECT sl.id, sl.total_cents, sl.game_cents, sl.buffet_cents, sl.sold_date, sl.created_at,
           ps.public_id, ps.system_number, ps.duration_sec, ps.started_at, ps.ended_at, ps.tariff_name
    FROM play_sales sl LEFT JOIN play_sessions ps ON ps.id = sl.session_id
    WHERE sl.gamenet_id=? ORDER BY sl.id DESC LIMIT 50`).all(req.gamenet.id);
  res.json({ ...s, invoices });
}));

/* ─────────────────────────  SYSTEMS CRUD  ───────────────────────── */

router.post('/systems', requireTenantOwner, rateLimit({ windowMs: 60000, max: 30 }), asyncHandler(async (req, res) => {
  const { number, name, type } = req.body || {};
  const num = str(number, 24).toUpperCase();
  if(!num) return res.status(400).json({ error: 'number_required', message: 'شماره سیستم الزامی است' });
  if(!SYSTEM_TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type', message: 'نوع سیستم نامعتبر است' });
  if(db.prepare('SELECT id FROM play_systems WHERE gamenet_id=? AND number=? COLLATE NOCASE').get(req.gamenet.id, num))
    return res.status(409).json({ error: 'number_exists', message: 'سیستمی با این شماره قبلاً ثبت شده' });
  const r = db.prepare(
    `INSERT INTO play_systems(gamenet_id,number,name,type) VALUES(?,?,?,?)`
  ).run(req.gamenet.id, num, str(name, 80), type);
  audit({ ...actorMeta(req), action: 'play.system_create', entity: 'play_system', entityId: r.lastInsertRowid, meta: { number: num, type } });
  res.status(201).json({ system: db.prepare('SELECT * FROM play_systems WHERE id=?').get(r.lastInsertRowid) });
}));

router.patch('/systems/:systemId', requireTenantOwner, asyncHandler(async (req, res) => {
  const sys = db.prepare('SELECT * FROM play_systems WHERE id=? AND gamenet_id=?').get(req.params.systemId, req.gamenet.id);
  if(!sys) return res.status(404).json({ error: 'not_found', message: 'سیستم یافت نشد' });
  const { name, type, status, sort_order } = req.body || {};
  if(openSession(sys.id)) return res.status(409).json({ error: 'session_open', message: 'ابتدا سشن در حال اجرا را پایان دهید' });
  if(status !== undefined){
    if(!MANUAL_SYSTEM_STATUSES.includes(status))
      return res.status(400).json({ error: 'invalid_status', message: 'وضعیت دستی نامعتبر است (in_use/paused فقط از طریق سشن تغییر می‌کند)' });
    db.prepare(`UPDATE play_systems SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, sys.id);
  }
  if(name !== undefined) db.prepare(`UPDATE play_systems SET name=?, updated_at=datetime('now') WHERE id=?`).run(str(name, 80), sys.id);
  if(type !== undefined){
    if(!SYSTEM_TYPES.includes(type)) return res.status(400).json({ error: 'invalid_type', message: 'نوع سیستم نامعتبر است' });
    db.prepare(`UPDATE play_systems SET type=?, updated_at=datetime('now') WHERE id=?`).run(type, sys.id);
  }
  if(sort_order !== undefined && Number.isFinite(Number(sort_order)))
    db.prepare(`UPDATE play_systems SET sort_order=? WHERE id=?`).run(Math.max(0, Math.min(9999, Number(sort_order)|0)), sys.id);
  audit({ ...actorMeta(req), action: 'play.system_update', entity: 'play_system', entityId: sys.id, meta: { status, name, type } });
  res.json({ system: db.prepare('SELECT * FROM play_systems WHERE id=?').get(sys.id) });
}));

router.delete('/systems/:systemId', requireTenantOwner, asyncHandler(async (req, res) => {
  const sys = db.prepare('SELECT * FROM play_systems WHERE id=? AND gamenet_id=?').get(req.params.systemId, req.gamenet.id);
  if(!sys) return res.status(404).json({ error: 'not_found', message: 'سیستم یافت نشد' });
  if(openSession(sys.id)) return res.status(409).json({ error: 'session_open', message: 'سیستم سشن باز دارد؛ ابتدا آن را پایان دهید' });
  const hasHistory = db.prepare('SELECT 1 FROM play_sessions WHERE system_id=? LIMIT 1').get(sys.id);
  if(hasHistory) return res.status(409).json({ error: 'has_history', message: 'این سیستم تاریخچه سشن دارد و قابل حذف نیست — برای خروج از دسترس، وضعیت «غیرفعال» بدهید' });
  db.prepare('DELETE FROM play_systems WHERE id=?').run(sys.id);
  audit({ ...actorMeta(req), action: 'play.system_delete', entity: 'play_system', entityId: sys.id, meta: { number: sys.number } });
  res.json({ ok: true });
}));

/* ─────────────────────────  SESSION LIFECYCLE  ───────────────────────── */

router.post('/systems/:systemId/start', rateLimit({ windowMs: 60000, max: 40 }), asyncHandler(async (req, res) => {
  const sys = db.prepare('SELECT * FROM play_systems WHERE id=? AND gamenet_id=?').get(req.params.systemId, req.gamenet.id);
  if(!sys) return res.status(404).json({ error: 'not_found', message: 'سیستم یافت نشد' });
  if(openSession(sys.id)) return res.status(409).json({ error: 'already_running', message: 'این سیستم هم‌اکنون سشن باز دارد' });
  // self-heal: in_use/paused without an open session (e.g. legacy/crash state)
  if(['in_use', 'paused'].includes(sys.status)){
    db.prepare(`UPDATE play_systems SET status='available', updated_at=datetime('now') WHERE id=?`).run(sys.id);
    sys.status = 'available';
  }
  if(!['available', 'reserved'].includes(sys.status))
    return res.status(409).json({ error: 'unavailable', message: `با وضعیت «${sys.status}» نمی‌توان بازی را شروع کرد` });

  const nowMs = Date.now();
  const tariff = matchTariff(req.gamenet.id, sys.type, nowMs);
  if(!tariff)
    return res.status(422).json({
      error: 'no_tariff',
      message: 'برای این نوع سیستم در این بازه زمانی تعرفه‌ای تعریف نشده است — ابتدا از «تعرفه و بوفه» تعرفه بسازید',
    });

  const startedAt = nowIso();
  const publicId = 'S-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const startedByName = str(req.user.name, 80) || req.user.email;

  const result = tx(() => {
    if(openSession(sys.id)) throw err409('already_running', 'این سیستم هم‌اکنون سشن باز دارد');
    const r = db.prepare(`
      INSERT INTO play_sessions(public_id,gamenet_id,system_id,system_number,system_name,system_type,
        status,started_at,tariff_id,tariff_name,rate_per_hour,started_by_user_id,started_by_name)
      VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?)
    `).run(publicId, req.gamenet.id, sys.id, sys.number, sys.name, sys.type,
      startedAt, tariff.id, tariff.name, tariff.rate_per_hour, req.user.id, startedByName);
    db.prepare(`UPDATE play_systems SET status='in_use', updated_at=datetime('now') WHERE id=?`).run(sys.id);
    return r.lastInsertRowid;
  });

  audit({ ...actorMeta(req), action: 'play.session_start', entity: 'play_session', entityId: result,
    meta: { system: sys.number, tariff: tariff.name, rate: tariff.rate_per_hour } });

  const s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(result);
  res.status(201).json({ session: sessionView(s, nowMs), server_now: nowMs });
}));

router.post('/sessions/:sessionId/pause', asyncHandler(async (req, res) => {
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
  if(!s) return res.status(404).json({ error: 'not_found', message: 'سشن یافت نشد' });
  if(s.status !== 'active') return res.status(409).json({ error: 'not_active', message: 'فقط سشن فعال را می‌توان متوقف کرد' });
  const nowMs = Date.now();
  const frozen = elapsedSec(s, nowMs);
  db.prepare(`UPDATE play_sessions SET status='paused', paused_at=? WHERE id=? AND status='active'`).run(nowIso(), s.id);
  db.prepare(`UPDATE play_systems SET status='paused', updated_at=datetime('now') WHERE id=?`).run(s.system_id);
  audit({ ...actorMeta(req), action: 'play.session_pause', entity: 'play_session', entityId: s.id, meta: { system: s.system_number, frozen_sec: frozen } });
  const fresh = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(s.id);
  res.json({ session: sessionView(fresh, nowMs), server_now: nowMs });
}));

router.post('/sessions/:sessionId/resume', asyncHandler(async (req, res) => {
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
  if(!s) return res.status(404).json({ error: 'not_found', message: 'سشن یافت نشد' });
  if(s.status !== 'paused') return res.status(409).json({ error: 'not_paused', message: 'سشن در حال توقف نیست' });
  const nowMs = Date.now();
  const pausedMs = utcMs(s.paused_at) || nowMs;
  const addSec = Math.max(0, Math.floor((nowMs - pausedMs)/1000));
  db.prepare(`UPDATE play_sessions SET status='active', paused_at=NULL, paused_total_sec=paused_total_sec+? WHERE id=? AND status='paused'`)
    .run(addSec, s.id);
  db.prepare(`UPDATE play_systems SET status='in_use', updated_at=datetime('now') WHERE id=?`).run(s.system_id);
  audit({ ...actorMeta(req), action: 'play.session_resume', entity: 'play_session', entityId: s.id, meta: { system: s.system_number, paused_sec: addSec } });
  const fresh = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(s.id);
  res.json({ session: sessionView(fresh, nowMs), server_now: nowMs });
}));

router.post('/sessions/:sessionId/stop', rateLimit({ windowMs: 60000, max: 60 }), asyncHandler(async (req, res) => {
  // NOTE: request body (if any) is deliberately IGNORED — amounts/times are server-computed.
  const nowMs = Date.now();
  const nowStr = nowIso();
  const endedByName = str(req.user.name, 80) || req.user.email;

  const out = tx(() => {
    const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
    if(!s) throw Object.assign(new Error('سشن یافت نشد'), { status: 404, code: 'not_found' });
    if(!['active', 'paused'].includes(s.status))
      throw Object.assign(new Error('این سشن قبلاً بسته شده است'), { status: 409, code: 'already_stopped' });

    const duration = elapsedSec(s, nowMs);
    const game = costFor(s.rate_per_hour, duration);
    const buffet = db.prepare(
      'SELECT COALESCE(SUM(line_total_cents),0) AS t FROM session_buffet_lines WHERE session_id=?').get(s.id).t;
    const total = game + buffet;

    const upd = db.prepare(`
      UPDATE play_sessions SET status='stopped', ended_at=?, duration_sec=?, paused_at=NULL,
        game_cost_cents=?, buffet_cost_cents=?, total_cents=?, ended_by_user_id=?, ended_by_name=?
      WHERE id=? AND status IN ('active','paused')
    `).run(nowStr, duration, game, buffet, total, req.user.id, endedByName, s.id);
    if(upd.changes !== 1) throw Object.assign(new Error('وضعیت سشن تغییر کرده — دوباره تلاش کنید'), { status: 409, code: 'conflict' });

    if(s.system_id)
      db.prepare(`UPDATE play_systems SET status='available', updated_at=datetime('now') WHERE id=?`).run(s.system_id);

    db.prepare(`
      INSERT INTO play_sales(gamenet_id,session_id,system_number,game_cents,buffet_cents,total_cents,sold_date)
      VALUES(?,?,?,?,?,?,?)
    `).run(req.gamenet.id, s.id, s.system_number, game, buffet, total, nowStr.slice(0,10));

    return { s, duration, game, buffet, total };
  });

  audit({ ...actorMeta(req), action: 'play.session_stop', entity: 'play_session', entityId: out.s.id,
    meta: { system: out.s.system_number, duration_sec: out.duration, game: out.game, buffet: out.buffet, total: out.total } });

  const fresh = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(out.s.id);
  const lines = db.prepare('SELECT * FROM session_buffet_lines WHERE session_id=? ORDER BY id').all(out.s.id);
  res.json({
    session: sessionView(fresh, nowMs),
    lines,
    server_now: nowMs,
    receipt: {
      public_id: fresh.public_id,
      system_number: fresh.system_number,
      started_at: fresh.started_at,
      ended_at: fresh.ended_at,
      duration_sec: out.duration,
      hms: hms(out.duration),
      tariff_name: fresh.tariff_name,
      rate_per_hour: fresh.rate_per_hour,
      game_cents: out.game,
      buffet_cents: out.buffet,
      total_cents: out.total,
      lines: lines.map(l => ({ name: l.item_name, qty: l.qty, unit: l.unit_price_cents, total: l.line_total_cents })),
    },
  });
}));

/* ─────────────────────────  BUFFET ON SESSION  ───────────────────────── */

router.post('/sessions/:sessionId/buffet', rateLimit({ windowMs: 60000, max: 120 }), asyncHandler(async (req, res) => {
  const { item_id, qty } = req.body || {};
  const q = Math.max(1, Math.min(99, parseInt(qty, 10) || 0));
  const nowMs = Date.now();
  const out = tx(() => {
    const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
    if(!s) throw Object.assign(new Error('سشن یافت نشد'), { status: 404, code: 'not_found' });
    if(!['active', 'paused'].includes(s.status))
      throw Object.assign(new Error('فقط روی سشن باز می‌توان سفارش ثبت کرد'), { status: 409, code: 'session_closed' });
    const item = db.prepare('SELECT * FROM buffet_items WHERE id=? AND gamenet_id=? AND active=1').get(item_id, req.gamenet.id);
    if(!item) throw Object.assign(new Error('آیتم بوفه یافت نشد'), { status: 404, code: 'item_not_found' });
    if(item.stock != null && item.stock < q)
      throw Object.assign(new Error(`موجودی ${item.name} کافی نیست (باقی‌مانده: ${item.stock})`), { status: 409, code: 'out_of_stock' });
    const unit = item.price_cents | 0;
    const lineTotal = unit * q;
    const r = db.prepare(`
      INSERT INTO session_buffet_lines(session_id,item_id,item_name,qty,unit_price_cents,line_total_cents,added_by_user_id)
      VALUES(?,?,?,?,?,?,?)
    `).run(s.id, item.id, item.name, q, unit, lineTotal, req.user.id);
    if(item.stock != null){
      const dec = db.prepare('UPDATE buffet_items SET stock = stock - ? WHERE id=? AND stock >= ?').run(q, item.id, q);
      if(dec.changes !== 1) throw Object.assign(new Error('موجودی بوفه کافی نیست'), { status: 409, code: 'out_of_stock' });
    }
    return { lineId: r.lastInsertRowid, lineTotal };
  });

  audit({ ...actorMeta(req), action: 'play.buffet_add', entity: 'play_session', entityId: req.params.sessionId,
    meta: { item_id, qty: q } });

  const s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sessionId);
  res.status(201).json({ line_id: out.lineId, session: sessionView(s, nowMs) });
}));

router.delete('/sessions/:sessionId/buffet/:lineId', asyncHandler(async (req, res) => {
  const nowMs = Date.now();
  tx(() => {
    const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
    if(!s) throw Object.assign(new Error('سشن یافت نشد'), { status: 404, code: 'not_found' });
    if(!['active', 'paused'].includes(s.status))
      throw Object.assign(new Error('سشن بسته است — سفارش قابل حذف نیست'), { status: 409, code: 'session_closed' });
    const line = db.prepare('SELECT * FROM session_buffet_lines WHERE id=? AND session_id=?').get(req.params.lineId, s.id);
    if(!line) throw Object.assign(new Error('سفارش یافت نشد'), { status: 404, code: 'line_not_found' });
    db.prepare('DELETE FROM session_buffet_lines WHERE id=?').run(line.id);
    if(line.item_id)
      db.prepare('UPDATE buffet_items SET stock = COALESCE(stock,0) + ? WHERE id=?').run(line.qty, line.item_id);
  });
  audit({ ...actorMeta(req), action: 'play.buffet_remove', entity: 'play_session', entityId: req.params.sessionId,
    meta: { line_id: req.params.lineId } });
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sessionId);
  res.json({ session: sessionView(s, nowMs) });
}));

/* ─────────────────────────  SESSION HISTORY  ───────────────────────── */

router.get('/sessions', asyncHandler(async (req, res) => {
  const { from, to, system, status } = req.query;
  let sql = `SELECT * FROM play_sessions WHERE gamenet_id=?`;
  const args = [req.gamenet.id];
  if(from){ sql += ` AND substr(started_at,1,10) >= ?`; args.push(String(from).slice(0,10)); }
  if(to){ sql += ` AND substr(started_at,1,10) <= ?`; args.push(String(to).slice(0,10)); }
  if(system){ sql += ` AND (system_number LIKE ? OR system_name LIKE ?)`; args.push(`%${String(system)}%`, `%${String(system)}%`); }
  if(status && ['active','paused','stopped','canceled'].includes(status)){ sql += ` AND status=?`; args.push(status); }
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS c');
  const total = db.prepare(countSql).get(...args).c;
  sql += ` ORDER BY id DESC LIMIT 200`;
  const nowMs = Date.now();
  const rows = db.prepare(sql).all(...args);
  res.json({ total, sessions: rows.map(s => sessionView(s, nowMs)) });
}));

router.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=? AND gamenet_id=?').get(req.params.sessionId, req.gamenet.id);
  if(!s) return res.status(404).json({ error: 'not_found', message: 'سشن یافت نشد' });
  const lines = db.prepare('SELECT * FROM session_buffet_lines WHERE session_id=? ORDER BY id').all(s.id);
  res.json({ session: sessionView(s, Date.now()), lines });
}));

/* ─────────────────────────  TARIFFS  ───────────────────────── */

router.get('/tariffs', asyncHandler(async (req, res) => {
  res.json({
    tariffs: db.prepare('SELECT * FROM tariffs WHERE gamenet_id=? ORDER BY priority DESC, id DESC').all(req.gamenet.id),
    holidays: db.prepare('SELECT * FROM gamenet_holidays WHERE gamenet_id=? ORDER BY holiday_date DESC LIMIT 200').all(req.gamenet.id),
  });
}));

function validateTariffBody(body, partial){
  const b = body || {};
  const out = {};
  if(!partial || b.name !== undefined){
    const name = str(b.name, 80);
    if(!name) return { error: 'نام تعرفه الزامی است' };
    out.name = name;
  }
  if(b.system_type !== undefined){
    if(b.system_type !== null && b.system_type !== '' && !SYSTEM_TYPES.includes(b.system_type))
      return { error: 'نوع سیستم نامعتبر است' };
    out.system_type = b.system_type || null;
  } else if(!partial) out.system_type = null;
  if(b.day_of_week !== undefined){
    const d = b.day_of_week === null || b.day_of_week === '' ? null : Number(b.day_of_week);
    if(d !== null && (!Number.isInteger(d) || d < 0 || d > 6)) return { error: 'روز هفته نامعتبر است' };
    out.day_of_week = d;
  } else if(!partial) out.day_of_week = null;
  const toMin = v => {
    if(v === null || v === undefined || v === '') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v));
    if(!m) return NaN;
    const hh = +m[1], mm = +m[2];
    if(hh > 23 || mm > 59) return NaN;
    return hh*60 + mm;
  };
  if(b.start_minute !== undefined || b.start_time !== undefined){
    const v = b.start_minute !== undefined ? b.start_minute : b.start_time;
    const m = v === null || v === '' ? null : (typeof v === 'number' ? v : toMin(v));
    if(Number.isNaN(m)) return { error: 'ساعت شروع نامعتبر است' };
    if(m !== null && (m < 0 || m > 1439)) return { error: 'ساعت شروع نامعتبر است' };
    out.start_minute = m;
  } else if(!partial) out.start_minute = null;
  if(b.end_minute !== undefined || b.end_time !== undefined){
    const v = b.end_minute !== undefined ? b.end_minute : b.end_time;
    const m = v === null || v === '' ? null : (typeof v === 'number' ? v : toMin(v));
    if(Number.isNaN(m)) return { error: 'ساعت پایان نامعتبر است' };
    if(m !== null && (m < 0 || m > 1439)) return { error: 'ساعت پایان نامعتبر است' };
    out.end_minute = m;
  } else if(!partial) out.end_minute = null;
  if(b.is_holiday !== undefined) out.is_holiday = b.is_holiday ? 1 : 0;
  else if(!partial) out.is_holiday = 0;
  if(!partial || b.rate_per_hour !== undefined){
    const rate = Math.floor(Number(b.rate_per_hour));
    if(!Number.isFinite(rate) || rate <= 0 || rate > 100000000)
      return { error: 'تعرفه (ریال در ساعت) نامعتبر است' };
    out.rate_per_hour = rate;
  }
  if(b.priority !== undefined) out.priority = Math.max(0, Math.min(999, Math.floor(Number(b.priority) || 0)));
  else if(!partial) out.priority = 0;
  if(b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

router.post('/tariffs', requireTenantOwner, rateLimit({ windowMs: 60000, max: 60 }), asyncHandler(async (req, res) => {
  const v = validateTariffBody(req.body, false);
  if(v.error) return res.status(400).json({ error: 'invalid_tariff', message: v.error });
  const r = db.prepare(`
    INSERT INTO tariffs(gamenet_id,name,system_type,day_of_week,start_minute,end_minute,is_holiday,rate_per_hour,priority,active)
    VALUES(?,?,?,?,?,?,?,?,?,1)
  `).run(req.gamenet.id, v.name, v.system_type, v.day_of_week, v.start_minute, v.end_minute, v.is_holiday, v.rate_per_hour, v.priority);
  audit({ ...actorMeta(req), action: 'play.tariff_create', entity: 'tariff', entityId: r.lastInsertRowid, meta: { name: v.name, rate: v.rate_per_hour } });
  res.status(201).json({ tariff: db.prepare('SELECT * FROM tariffs WHERE id=?').get(r.lastInsertRowid) });
}));

router.patch('/tariffs/:tariffId', requireTenantOwner, asyncHandler(async (req, res) => {
  const t = db.prepare('SELECT * FROM tariffs WHERE id=? AND gamenet_id=?').get(req.params.tariffId, req.gamenet.id);
  if(!t) return res.status(404).json({ error: 'not_found', message: 'تعرفه یافت نشد' });
  const v = validateTariffBody(req.body, true);
  if(v.error) return res.status(400).json({ error: 'invalid_tariff', message: v.error });
  const merged = { ...t, ...v };
  db.prepare(`
    UPDATE tariffs SET name=?, system_type=?, day_of_week=?, start_minute=?, end_minute=?,
      is_holiday=?, rate_per_hour=?, priority=?, active=? WHERE id=?
  `).run(merged.name, merged.system_type, merged.day_of_week, merged.start_minute, merged.end_minute,
    merged.is_holiday, merged.rate_per_hour, merged.priority, merged.active, t.id);
  audit({ ...actorMeta(req), action: 'play.tariff_update', entity: 'tariff', entityId: t.id, meta: v });
  res.json({ tariff: db.prepare('SELECT * FROM tariffs WHERE id=?').get(t.id) });
}));

router.delete('/tariffs/:tariffId', requireTenantOwner, asyncHandler(async (req, res) => {
  const t = db.prepare('SELECT * FROM tariffs WHERE id=? AND gamenet_id=?').get(req.params.tariffId, req.gamenet.id);
  if(!t) return res.status(404).json({ error: 'not_found', message: 'تعرفه یافت نشد' });
  db.prepare('DELETE FROM tariffs WHERE id=?').run(t.id);
  audit({ ...actorMeta(req), action: 'play.tariff_delete', entity: 'tariff', entityId: t.id, meta: { name: t.name } });
  res.json({ ok: true });
}));

/* ─────────────────────────  HOLIDAYS  ───────────────────────── */

router.post('/holidays', requireTenantOwner, asyncHandler(async (req, res) => {
  const { holiday_date, name } = req.body || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(holiday_date || '')) ? String(holiday_date) : null;
  if(!d) return res.status(400).json({ error: 'invalid_date', message: 'تاریخ تعطیل باید به شکل YYYY-MM-DD باشد' });
  try{
    const r = db.prepare('INSERT INTO gamenet_holidays(gamenet_id,holiday_date,name) VALUES(?,?,?)')
      .run(req.gamenet.id, d, str(name, 80));
    audit({ ...actorMeta(req), action: 'play.holiday_create', entity: 'holiday', entityId: r.lastInsertRowid, meta: { date: d } });
    res.status(201).json({ holiday: db.prepare('SELECT * FROM gamenet_holidays WHERE id=?').get(r.lastInsertRowid) });
  }catch(e){
    return res.status(409).json({ error: 'exists', message: 'این تاریخ قبلاً ثبت شده' });
  }
}));

router.delete('/holidays/:holidayId', requireTenantOwner, asyncHandler(async (req, res) => {
  const h = db.prepare('SELECT * FROM gamenet_holidays WHERE id=? AND gamenet_id=?').get(req.params.holidayId, req.gamenet.id);
  if(!h) return res.status(404).json({ error: 'not_found', message: 'تعطیلی یافت نشد' });
  db.prepare('DELETE FROM gamenet_holidays WHERE id=?').run(h.id);
  audit({ ...actorMeta(req), action: 'play.holiday_delete', entity: 'holiday', entityId: h.id, meta: { date: h.holiday_date } });
  res.json({ ok: true });
}));

/* ─────────────────────────  BUFFET CATALOG  ───────────────────────── */

router.get('/buffet', asyncHandler(async (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM buffet_items WHERE gamenet_id=? ORDER BY name').all(req.gamenet.id) });
}));

router.post('/buffet', requireTenantOwner, rateLimit({ windowMs: 60000, max: 60 }), asyncHandler(async (req, res) => {
  const { name, price_cents, stock } = req.body || {};
  const nm = str(name, 80);
  const price = Math.floor(Number(price_cents));
  if(!nm) return res.status(400).json({ error: 'name_required', message: 'نام آیتم الزامی است' });
  if(!Number.isFinite(price) || price < 0 || price > 100000000)
    return res.status(400).json({ error: 'invalid_price', message: 'قیمت نامعتبر است' });
  let st = null;
  if(stock !== undefined && stock !== null && stock !== ''){
    st = Math.floor(Number(stock));
    if(!Number.isFinite(st) || st < 0) return res.status(400).json({ error: 'invalid_stock', message: 'موجودی نامعتبر است' });
  }
  try{
    const r = db.prepare('INSERT INTO buffet_items(gamenet_id,name,price_cents,stock) VALUES(?,?,?,?)')
      .run(req.gamenet.id, nm, price, st);
    audit({ ...actorMeta(req), action: 'play.buffet_item_create', entity: 'buffet_item', entityId: r.lastInsertRowid, meta: { name: nm, price } });
    res.status(201).json({ item: db.prepare('SELECT * FROM buffet_items WHERE id=?').get(r.lastInsertRowid) });
  }catch(e){
    return res.status(409).json({ error: 'exists', message: 'آیتمی با این نام قبلاً ثبت شده' });
  }
}));

router.patch('/buffet/:itemId', requireTenantOwner, asyncHandler(async (req, res) => {
  const item = db.prepare('SELECT * FROM buffet_items WHERE id=? AND gamenet_id=?').get(req.params.itemId, req.gamenet.id);
  if(!item) return res.status(404).json({ error: 'not_found', message: 'آیتم یافت نشد' });
  const { name, price_cents, stock, active } = req.body || {};
  let nm = item.name, price = item.price_cents, st = item.stock, act = item.active;
  if(name !== undefined){ nm = str(name, 80); if(!nm) return res.status(400).json({ error: 'name_required', message: 'نام الزامی است' }); }
  if(price_cents !== undefined){
    price = Math.floor(Number(price_cents));
    if(!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'invalid_price', message: 'قیمت نامعتبر است' });
  }
  if(stock !== undefined){
    if(stock === null || stock === '') st = null;
    else { st = Math.floor(Number(stock)); if(!Number.isFinite(st) || st < 0) return res.status(400).json({ error: 'invalid_stock', message: 'موجودی نامعتبر است' }); }
  }
  if(active !== undefined) act = active ? 1 : 0;
  db.prepare('UPDATE buffet_items SET name=?, price_cents=?, stock=?, active=? WHERE id=?').run(nm, price, st, act, item.id);
  audit({ ...actorMeta(req), action: 'play.buffet_item_update', entity: 'buffet_item', entityId: item.id, meta: { price, stock: st, active: act } });
  res.json({ item: db.prepare('SELECT * FROM buffet_items WHERE id=?').get(item.id) });
}));

router.delete('/buffet/:itemId', requireTenantOwner, asyncHandler(async (req, res) => {
  const item = db.prepare('SELECT * FROM buffet_items WHERE id=? AND gamenet_id=?').get(req.params.itemId, req.gamenet.id);
  if(!item) return res.status(404).json({ error: 'not_found', message: 'آیتم یافت نشد' });
  db.prepare('DELETE FROM buffet_items WHERE id=?').run(item.id);
  audit({ ...actorMeta(req), action: 'play.buffet_item_delete', entity: 'buffet_item', entityId: item.id, meta: { name: item.name } });
  res.json({ ok: true });
}));

module.exports = router;
