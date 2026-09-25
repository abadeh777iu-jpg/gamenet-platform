'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./index');

// schema.sql is inlined at build time by esbuild (--loader:.sql=text).
// On plain Node (tests/local), fall back to reading from disk.
function loadSchema(){
  try{
    const embedded = require('./schema.sql');
    if(typeof embedded === 'string' && embedded.length > 0) return embedded;
  }catch(e){ /* not bundled as text */ }
  const candidates = [
    (typeof __dirname !== 'undefined' && path.join(__dirname, 'schema.sql')),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'schema.sql'),
  ].filter(Boolean);
  for(const p of candidates){
    try{ return fs.readFileSync(p, 'utf8'); }catch(e){}
  }
  throw new Error('schema.sql not found');
}

/**
 * 002_play — GameNet play-session subsystem (systems, tariffs, sessions,
 * buffet, sales). Kept as a JS string so it bundles on Workers without
 * requiring a second .sql text-loader entry. Fully idempotent (IF NOT EXISTS).
 */
const SQL_002_PLAY = `
CREATE TABLE IF NOT EXISTS play_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'pc' CHECK(type IN ('pc','console','playstation','xbox','vip','other')),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','in_use','reserved','paused','maintenance','broken','disabled')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(gamenet_id, number)
);
CREATE INDEX IF NOT EXISTS idx_play_systems_gamenet ON play_systems(gamenet_id, status);

CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_type TEXT CHECK(system_type IN ('pc','console','playstation','xbox','vip','other')),
  day_of_week INTEGER CHECK(day_of_week BETWEEN 0 AND 6),
  start_minute INTEGER,
  end_minute INTEGER,
  is_holiday INTEGER NOT NULL DEFAULT 0,
  rate_per_hour INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tariffs_gamenet ON tariffs(gamenet_id, active);

CREATE TABLE IF NOT EXISTS gamenet_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  holiday_date TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  UNIQUE(gamenet_id, holiday_date)
);
CREATE INDEX IF NOT EXISTS idx_holidays_gamenet ON gamenet_holidays(gamenet_id, holiday_date);

CREATE TABLE IF NOT EXISTS play_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  system_id INTEGER REFERENCES play_systems(id) ON DELETE SET NULL,
  system_number TEXT NOT NULL,
  system_name TEXT NOT NULL DEFAULT '',
  system_type TEXT NOT NULL DEFAULT 'pc',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','stopped','canceled')),
  source TEXT NOT NULL DEFAULT 'panel',
  started_at TEXT NOT NULL,
  paused_at TEXT,
  paused_total_sec INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  tariff_id INTEGER REFERENCES tariffs(id) ON DELETE SET NULL,
  tariff_name TEXT NOT NULL DEFAULT '',
  rate_per_hour INTEGER NOT NULL DEFAULT 0,
  game_cost_cents INTEGER NOT NULL DEFAULT 0,
  buffet_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  started_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ended_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_by_name TEXT NOT NULL DEFAULT '',
  ended_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_gamenet_started ON play_sessions(gamenet_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON play_sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_open_system
  ON play_sessions(system_id) WHERE status IN ('active','paused') AND system_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS buffet_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(gamenet_id, name)
);

CREATE TABLE IF NOT EXISTS session_buffet_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES buffet_items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL,
  added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buffet_lines_session ON session_buffet_lines(session_id);

CREATE TABLE IF NOT EXISTS play_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamenet_id INTEGER NOT NULL REFERENCES gamenets(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES play_sessions(id) ON DELETE SET NULL,
  system_number TEXT NOT NULL DEFAULT '',
  game_cents INTEGER NOT NULL DEFAULT 0,
  buffet_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  sold_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_gamenet_date ON play_sales(gamenet_id, sold_date);
`;

/**
 * 003_license_events — admin-run license events: grant free N-day licenses
 * (default 1 month) to any gamenet, deactivate an event to revoke them all.
 */
const SQL_003_EVENTS = `
CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function ensureLicenseEventColumn(){
  const cols = db.prepare(`PRAGMA table_info(licenses)`).all().map(c => c.name);
  if(!cols.includes('event_id')){
    db.exec(`ALTER TABLE licenses ADD COLUMN event_id INTEGER REFERENCES license_events(id)`);
    console.log('applied licenses.event_id column');
  }
}

function migrate(){
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const sql = loadSchema();
  const applied = db.prepare('SELECT name FROM _migrations').all().map(r=>r.name);
  if(!applied.includes('001_schema')){
    db.transaction(()=>{ db.exec(sql); db.prepare('INSERT INTO _migrations(name) VALUES(?)').run('001_schema'); })();
    console.log('applied 001_schema');
  }
  if(!applied.includes('002_play')){
    db.transaction(()=>{ db.exec(SQL_002_PLAY); db.prepare('INSERT INTO _migrations(name) VALUES(?)').run('002_play'); })();
    console.log('applied 002_play');
  }
  if(!applied.includes('003_license_events')){
    db.transaction(()=>{
      db.exec(SQL_003_EVENTS);
      ensureLicenseEventColumn();
      db.prepare('INSERT INTO _migrations(name) VALUES(?)').run('003_license_events');
    })();
    console.log('applied 003_license_events');
  }
  console.log('migrations up-to-date');
}

if(typeof require !== 'undefined' && require.main === module){ migrate(); }
module.exports = { migrate };
