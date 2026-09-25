'use strict';
/**
 * Play-session domain service — all time & money math lives HERE (server-side).
 * Clients never compute authoritative values: duration = (end − start − pauses)
 * from DB timestamps; cost = floor(rate × seconds / 3600) in integer rials
 * (no floating point, no accumulation → no rounding drift).
 */
const { db, nowIso } = require('../db');

const OPEN_STATUSES = ['active', 'paused'];
const SYSTEM_TYPES = ['pc', 'console', 'playstation', 'xbox', 'vip', 'other'];
const SYSTEM_STATUSES = ['available', 'in_use', 'reserved', 'paused', 'maintenance', 'broken', 'disabled'];
const MANUAL_SYSTEM_STATUSES = ['available', 'reserved', 'maintenance', 'broken', 'disabled'];

/** SQLite datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS' → epoch ms */
function utcMs(s){
  if(!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
  if(!m) return null;
  return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
}
function hms(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec/3600)).padStart(2,'0');
  const m = String(Math.floor((sec%3600)/60)).padStart(2,'0');
  const s = String(sec%60).padStart(2,'0');
  return `${h}:${m}:${s}`;
}
/** Integer-rial cost for elapsed seconds at an hourly rate — floor, exact & idempotent. */
function costFor(ratePerHour, elapsedSec){
  if(!ratePerHour || elapsedSec <= 0) return 0;
  return Math.floor((Math.floor(ratePerHour) * Math.floor(elapsedSec)) / 3600);
}
/**
 * Authoritative elapsed seconds of a session at a given instant.
 * active  → now − start − completed pauses
 * paused  → paused_at − start − completed pauses (frozen)
 * stopped → ended_at − start − completed pauses (stored as duration_sec anyway)
 */
function elapsedSec(session, nowMs){
  const start = utcMs(session.started_at);
  if(start == null) return 0;
  let end;
  if(session.status === 'active') end = nowMs;
  else if(session.status === 'paused') end = utcMs(session.paused_at);
  else end = utcMs(session.ended_at);
  if(end == null) end = nowMs;
  return Math.max(0, Math.floor((end - start)/1000) - (session.paused_total_sec|0));
}

function openSession(systemId){
  return db.prepare(`SELECT * FROM play_sessions WHERE system_id=? AND status IN ('active','paused')`).get(systemId);
}
function openSessions(gamenetId){
  return db.prepare(`SELECT * FROM play_sessions WHERE gamenet_id=? AND status IN ('active','paused') ORDER BY id`).all(gamenetId);
}

function inHoliday(gamenetId, dateStr){
  return !!db.prepare(`SELECT id FROM gamenet_holidays WHERE gamenet_id=? AND holiday_date=?`).get(gamenetId, dateStr);
}

/**
 * Pick the tariff for (gamenet, system type) at instant `atMs` (default now).
 * Matching rules — all optional dimensions must match; highest score wins:
 *   priority DESC → holiday-specific DESC → type-specific DESC →
 *   weekday-specific DESC → time-window DESC → id DESC
 * Overnight windows (start > end) wrap around midnight.
 * Returns null when nothing matches (start is then rejected).
 */
function matchTariff(gamenetId, systemType, atMs){
  const d = new Date(atMs == null ? Date.now() : atMs);
  const dateStr = d.toISOString().slice(0,10);
  const dow = d.getUTCDay();
  const minuteOfDay = d.getUTCHours()*60 + d.getUTCMinutes();
  const holiday = inHoliday(gamenetId, dateStr) ? 1 : 0;
  const rows = db.prepare(`
    SELECT * FROM tariffs
    WHERE gamenet_id=? AND active=1
      AND (system_type IS NULL OR system_type=?)
      AND (day_of_week IS NULL OR day_of_week=?)
      AND (is_holiday=0 OR ?=1)
      AND (
        start_minute IS NULL OR end_minute IS NULL OR start_minute=end_minute OR
        (start_minute < end_minute AND start_minute <= ? AND ? < end_minute) OR
        (start_minute > end_minute AND (? >= start_minute OR ? < end_minute))
      )
    ORDER BY priority DESC,
             is_holiday DESC,
             (system_type IS NOT NULL) DESC,
             (day_of_week IS NOT NULL) DESC,
             ((start_minute IS NOT NULL) AND (end_minute IS NOT NULL)) DESC,
             id DESC
  `).all(gamenetId, systemType, dow, holiday, minuteOfDay, minuteOfDay, minuteOfDay, minuteOfDay);
  return rows[0] || null;
}

/** Snapshot view of one session for API payloads (computed at `nowMs`). */
function sessionView(s, nowMs){
  const elapsed = s.status === 'stopped' || s.status === 'canceled'
    ? (s.duration_sec|0)
    : elapsedSec(s, nowMs);
  const game = s.status === 'stopped' || s.status === 'canceled'
    ? (s.game_cost_cents|0)
    : costFor(s.rate_per_hour, elapsed);
  // For open sessions buffet total is summed live from lines; stopped sessions
  // expose the frozen snapshot stored at stop time.
  const buffet = (s.status === 'stopped' || s.status === 'canceled')
    ? (s.buffet_cost_cents|0)
    : db.prepare('SELECT COALESCE(SUM(line_total_cents),0) AS t FROM session_buffet_lines WHERE session_id=?').get(s.id).t;
  return {
    id: s.id,
    public_id: s.public_id,
    system_id: s.system_id,
    system_number: s.system_number,
    system_name: s.system_name,
    system_type: s.system_type,
    status: s.status,
    started_at: s.started_at,
    started_at_ms: utcMs(s.started_at),
    paused_at: s.paused_at,
    paused_at_ms: utcMs(s.paused_at),
    paused_total_sec: s.paused_total_sec|0,
    ended_at: s.ended_at,
    duration_sec: s.duration_sec|0,
    elapsed_sec: elapsed,
    hms: hms(elapsed),
    tariff_id: s.tariff_id,
    tariff_name: s.tariff_name,
    rate_per_hour: s.rate_per_hour|0,
    game_cost_cents: game,
    buffet_cost_cents: buffet,
    total_cents: (s.status === 'stopped' || s.status === 'canceled')
      ? (s.total_cents|0)
      : game + buffet,
    started_by_name: s.started_by_name,
    ended_by_name: s.ended_by_name,
  };
}

/** All systems of a tenant with their open sessions attached (live overview). */
function liveOverview(gamenetId, nowMs){
  nowMs = nowMs || Date.now();
  const systems = db.prepare(`SELECT * FROM play_systems WHERE gamenet_id=? ORDER BY sort_order, id`).all(gamenetId);
  const open = {};
  for(const s of openSessions(gamenetId)) open[s.system_id] = sessionView(s, nowMs);
  return systems.map(sys => {
    // display self-heal: in_use/paused rows without an open session read as available
    let status = open[sys.id]
      ? (open[sys.id].status === 'paused' ? 'paused' : 'in_use')
      : (['in_use', 'paused'].includes(sys.status) ? 'available' : sys.status);
    return {
      id: sys.id,
      number: sys.number,
      name: sys.name,
      type: sys.type,
      status,
      db_status: sys.status,
      sort_order: sys.sort_order,
      open_session: open[sys.id] || null,
    };
  });
}

/** Daily dashboard: counts, play time, revenue per system, top systems. */
function dashboardStats(gamenetId, nowMs){
  nowMs = nowMs || Date.now();
  const today = new Date(nowMs).toISOString().slice(0,10);
  const systems = db.prepare(`SELECT status, COUNT(*) c FROM play_systems WHERE gamenet_id=? GROUP BY status`).all(gamenetId);
  const by = {}; for(const r of systems) by[r.status] = r.c;
  const total = systems.reduce((a,r)=>a+r.c, 0);
  const count = st => by[st] || 0;
  const activeSystems = total - count('broken') - count('disabled') - count('maintenance');

  const sessionsToday = db.prepare(
    `SELECT * FROM play_sessions WHERE gamenet_id=? AND substr(started_at,1,10)=?`
  ).all(gamenetId, today);

  let playTimeSec = 0, openTimeSec = 0, gameRevenue = 0;
  const perSystem = {};
  const bump = (num) => (perSystem[num] = perSystem[num] || { system_number: num, sessions: 0, play_sec: 0, game_cents: 0, buffet_cents: 0, total_cents: 0 });

  for(const s of sessionsToday){
    const v = sessionView(s, nowMs);
    const row = bump(s.system_number);
    row.sessions += 1;
    if(s.status === 'stopped' || s.status === 'canceled'){
      playTimeSec += v.duration_sec;
      gameRevenue += v.game_cost_cents;
      row.play_sec += v.duration_sec;
      row.game_cents += v.game_cost_cents;
      row.buffet_cents += v.buffet_cost_cents;
      row.total_cents += v.total_cents;
    } else {
      openTimeSec += v.elapsed_sec;
      gameRevenue += v.game_cost_cents;
      row.play_sec += v.elapsed_sec;
      row.game_cents += v.game_cost_cents;
      row.buffet_cents += v.buffet_cost_cents;
      row.total_cents += v.total_cents;
    }
  }
  const sales = db.prepare(
    `SELECT COALESCE(SUM(game_cents),0) g, COALESCE(SUM(buffet_cents),0) b, COALESCE(SUM(total_cents),0) t, COUNT(*) c
     FROM play_sales WHERE gamenet_id=? AND sold_date=?`
  ).get(gamenetId, today);

  const perSystemRows = Object.values(perSystem).sort((a,b)=> b.total_cents - a.total_cents);
  return {
    server_now: nowMs,
    today,
    systems_total: total,
    systems_active: activeSystems,
    systems_in_use: count('in_use'),
    systems_available: count('available'),
    systems_reserved: count('reserved'),
    systems_paused: count('paused'),
    sessions_today: sessionsToday.length,
    sessions_open: sessionsToday.filter(s=>OPEN_STATUSES.includes(s.status)).length,
    play_time_today_sec: playTimeSec + openTimeSec,
    play_time_closed_sec: playTimeSec,
    game_revenue_today: gameRevenue,
    buffet_revenue_today: sales.b,
    total_revenue_today: sales.t,
    sales_count_today: sales.c,
    per_system: perSystemRows,
    top_systems: perSystemRows.slice(0, 5),
  };
}

/**
 * Storage is repurposed per owner decision: instead of customer file uploads,
 * a tenant's quota covers PERSISTED SETTINGS + GAME INVOICES (systems, prices,
 * buffet, sessions, sales, audit). Size is an integer approximation of the
 * row bytes this tenant occupies; limit comes from the gamenet quota.
 */
function storageSummary(gamenetId){
  const sum = (sql) => db.prepare(sql).get(gamenetId);
  const parts = {
    systems:  sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(number)+LENGTH(name)+48),0) b FROM play_systems WHERE gamenet_id=?`),
    tariffs:  sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(name)+80),0) b FROM tariffs WHERE gamenet_id=?`),
    buffet:   sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(name)+48),0) b FROM buffet_items WHERE gamenet_id=?`),
    sessions: sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(public_id)+LENGTH(system_number)+LENGTH(system_name)+LENGTH(tariff_name)+LENGTH(started_by_name)+LENGTH(ended_by_name)+200),0) b FROM play_sessions WHERE gamenet_id=?`),
    invoices: sum(`SELECT COUNT(*) c, COALESCE(SUM(140),0) b FROM play_sales WHERE gamenet_id=?`),
    audit:    sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(action)+LENGTH(entity)+LENGTH(entity_id)+LENGTH(meta_json)+LENGTH(ip)+96),0) b FROM audit_logs WHERE gamenet_id=?`),
  };
  const lines = sum(`SELECT COUNT(*) c, COALESCE(SUM(LENGTH(item_name)+64),0) b
    FROM session_buffet_lines l JOIN play_sessions s ON s.id=l.session_id WHERE s.gamenet_id=?`);
  parts.lines = lines;
  const used = Object.values(parts).reduce((a, p) => a + (p.b|0), 0);
  const g = db.prepare(`SELECT storage_limit_bytes FROM gamenets WHERE id=?`).get(gamenetId);
  const limit = (g && g.storage_limit_bytes) || 0;
  return {
    used_bytes: used,
    limit_bytes: limit,
    ratio: limit ? Math.min(1, used / limit) : 0,
    counts: {
      systems: parts.systems.c,
      tariffs: parts.tariffs.c,
      buffet_items: parts.buffet.c,
      sessions: parts.sessions.c,
      invoices: parts.invoices.c,
      buffet_lines: lines.c,
      audit: parts.audit.c,
    },
    breakdown: Object.entries(parts).map(([k, v]) => ({ kind: k, count: v.c, bytes: v.b|0 })),
  };
}

module.exports = {
  OPEN_STATUSES, SYSTEM_TYPES, SYSTEM_STATUSES, MANUAL_SYSTEM_STATUSES,
  utcMs, hms, costFor, elapsedSec, matchTariff, sessionView,
  openSession, openSessions, liveOverview, dashboardStats, inHoliday, storageSummary,
};
