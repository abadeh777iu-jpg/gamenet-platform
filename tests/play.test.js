'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');
const { db } = require('../src/db');
const { costFor, matchTariff, elapsedSec, hms, utcMs } = require('../src/services/play');

async function ownerSetup(tag, { license = true } = {}){
  const ts = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const email = `play_${tag}_${ts}@t.local`.replace(/[^a-z0-9@._-]/gi, '');
  const r = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: 'Owner ' + tag } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const jar = cookieJar(r.setCookie), csrf = csrfOf(r.setCookie);
  const g = await req(app, 'POST', '/api/gamenets', {
    cookie: jar, headers: { 'x-csrf-token': csrf },
    body: { name: 'Play Club ' + ts, slug: 'play-' + ts.replace(/[^a-z0-9]/gi, '') },
  });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  const gid = g.data.gamenet.id;
  if(license){
    const { issueLicense } = require('../src/services/license');
    issueLicense({ gamenetId: gid, subscriptionId: null,
      expiresAt: new Date(Date.now() + 30*86400000).toISOString().slice(0,19).replace('T',' ') });
  }
  return { jar, csrf, uid: r.data.user.id, gid, email };
}
const auth = s => ({ cookie: s.jar, headers: { 'x-csrf-token': s.csrf } });
const P = (s, p) => `/api/gamenets/${s.gid}/play${p}`;

/* ── unit: integer cost math (rounding-safe) ── */
test('costFor is integer-exact (no rounding drift)', () => {
  assert.equal(costFor(1000, 90), 25);              // 1000×90/3600 = 25
  assert.equal(costFor(300000, 6327), 527250);       // 01:45:27 example
  assert.equal(costFor(300000, 0), 0);
  assert.equal(costFor(0, 1234), 0);
  // floor semantics: 1 second at 1000/hour = 0 rials, not 0.27
  assert.equal(costFor(1000, 1), 0);
  assert.equal(costFor(1000, 3601), 1000);
  // repeated partial windows sum to the whole (floor is applied once at the end)
  assert.equal(costFor(999999, 1), Math.floor(999999 / 3600));
});

test('elapsedSec uses timestamps minus pauses (frozen while paused)', () => {
  const start = Date.now() - (3600 * 1000); // 1h ago
  const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const active = { started_at: iso(start), status: 'active', paused_total_sec: 0, paused_at: null };
  const now = Date.now();
  const e = elapsedSec(active, now);
  assert.ok(Math.abs(e - 3600) <= 1, 'elapsed≈3600 got ' + e);

  const paused = { started_at: iso(start), status: 'paused', paused_total_sec: 0, paused_at: iso(now - 60000) };
  const ep = elapsedSec(paused, now);
  assert.ok(Math.abs(ep - 3540) <= 2, 'paused freezes ~1 min before now, got ' + ep);

  const withPauses = { started_at: iso(start), status: 'active', paused_total_sec: 300, paused_at: null };
  const ew = elapsedSec(withPauses, now);
  assert.ok(Math.abs(ew - 3300) <= 2, 'pauses subtracted, got ' + ew);
  assert.equal(hms(6327), '01:45:27');
});

test('matchTariff: specificity, time windows, holidays, priority', () => {
  // FK-safe owner row
  const u = db.prepare(`INSERT INTO users(email,name) VALUES(?,?)`).run(`mt_${Date.now()}@t.local`, 'MT');
  const r = db.prepare(`INSERT INTO gamenets(slug,name,owner_user_id) VALUES(?,?,?)`).run('mt-' + Date.now(), 'Match Test', u.lastInsertRowid);
  const gid = r.lastInsertRowid;
  const ins = t => db.prepare(`INSERT INTO tariffs(gamenet_id,name,system_type,day_of_week,start_minute,end_minute,is_holiday,rate_per_hour,priority,active)
    VALUES(@g,@n,@ty,@d,@s,@e,@h,@r,@p,1)`).run({ g: gid, n: 't', ty: null, d: null, s: null, e: null, h: 0, r: 1000, p: 0, ...t });

  ins({ n: 'base', r: 1000 });
  ins({ n: 'pc', ty: 'pc', r: 2000 });
  ins({ n: 'vip-holiday', ty: 'vip', h: 1, r: 9000, p: 10 });
  ins({ n: 'night', s: 22 * 60, e: 2 * 60, r: 5000, p: 7 });          // 22:00→02:00 overnight
  ins({ n: 'friday', d: 5, r: 3000, p: 3 });                            // Friday (JS getDay=5)

  // pick a real Tuesday and a real Friday from the calendar (UTC)
  let tue = Date.UTC(2026, 8, 20, 12, 0, 0);
  while(new Date(tue).getUTCDay() !== 2) tue += 86400000;
  let fri = Date.UTC(2026, 8, 20, 12, 0, 0);
  while(new Date(fri).getUTCDay() !== 5) fri += 86400000;

  assert.equal(matchTariff(gid, 'pc', tue).name, 'pc', 'type-specific beats base');
  assert.equal(matchTariff(gid, 'xbox', tue).name, 'base', 'base applies to others');

  // night window overnight: 23:30 → night (priority 7), also after midnight 01:30
  const night = Date.UTC(2026, 8, 22, 23, 30, 0);
  assert.equal(matchTariff(gid, 'pc', night).name, 'night', 'overnight window covers 23:30');
  const night2 = Date.UTC(2026, 8, 23, 1, 30, 0);
  assert.equal(matchTariff(gid, 'pc', night2).name, 'night', 'window wraps past midnight');

  // Friday: friday tariff priority 3 > pc priority 0 → wins
  assert.equal(matchTariff(gid, 'pc', fri).name, 'friday', 'day-specific priority wins');

  // Holiday: vip-holiday (p=10) wins on a holiday date for vip
  const tueDate = new Date(tue).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO gamenet_holidays(gamenet_id,holiday_date,name) VALUES(?,?,?)`).run(gid, tueDate, 'test');
  assert.equal(matchTariff(gid, 'vip', tue).name, 'vip-holiday', 'holiday tariff wins on holiday');
  assert.notEqual(matchTariff(gid, 'vip', fri).name, 'vip-holiday', 'holiday tariff inactive on normal day');
  db.prepare(`DELETE FROM gamenet_holidays WHERE gamenet_id=?`).run(gid);
  assert.equal(matchTariff(gid, 'vip', tue).name, 'base');
  db.prepare('DELETE FROM gamenets WHERE id=?').run(gid);
});

/* ── API lifecycle ── */
test('session lifecycle: start → live → pause/resume → stop (server-computed)', async () => {
  const s = await ownerSetup('life');
  // no tariff yet → start must fail with 422
  let rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'PC-07', name: 'کنار پنجره', type: 'pc' } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const sysId = rr.data.system.id;

  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  assert.equal(rr.status, 422, JSON.stringify(rr.data));
  assert.equal(rr.data.error, 'no_tariff');

  // define tariff → start OK
  rr = await req(app, 'POST', P(s, '/tariffs'), { ...auth(s), body: { name: 'پایه', system_type: 'pc', rate_per_hour: 300000 } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const ses = rr.data.session;
  assert.equal(ses.status, 'active');
  assert.equal(ses.rate_per_hour, 300000, 'rate snapshotted from tariff at start');
  assert.ok(ses.public_id.startsWith('S-'));

  // double start → 409
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  assert.equal(rr.status, 409);

  // live view: elapsed from timestamps; rewind start by 01:45:27 (6327s)
  db.prepare(`UPDATE play_sessions SET started_at=datetime('now','-6327 seconds') WHERE id=?`).run(ses.id);
  rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 200);
  const liveSys = rr.data.systems.find(x => x.id === sysId);
  assert.equal(liveSys.status, 'in_use');
  const os = liveSys.open_session;
  assert.ok(Math.abs(os.elapsed_sec - 6327) <= 2, 'elapsed≈6327 got ' + os.elapsed_sec);
  assert.equal(os.game_cost_cents, Math.floor(300000 * os.elapsed_sec / 3600), 'live cost = rate×sec/3600 floor');
  assert.equal(rr.data.server_now > 0, true);

  // pause → frozen; rewind paused_at by 100s → resume accumulates paused_total ≥100
  rr = await req(app, 'POST', P(s, `/sessions/${ses.id}/pause`), { ...auth(s), body: {} });
  assert.equal(rr.status, 200);
  assert.equal(rr.data.session.status, 'paused');
  db.prepare(`UPDATE play_sessions SET paused_at=datetime('now','-100 seconds') WHERE id=?`).run(ses.id);
  rr = await req(app, 'POST', P(s, `/sessions/${ses.id}/resume`), { ...auth(s), body: {} });
  assert.equal(rr.status, 200);
  assert.ok(rr.data.session.paused_total_sec >= 100, 'paused span recorded, got ' + rr.data.session.paused_total_sec);

  // buffet: stock decrement on add
  rr = await req(app, 'POST', P(s, '/buffet'), { ...auth(s), body: { name: 'نوشابه', price_cents: 25000, stock: 10 } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const itemId = rr.data.item.id;
  rr = await req(app, 'POST', P(s, `/sessions/${ses.id}/buffet`), { ...auth(s), body: { item_id: itemId, qty: 2 } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  assert.equal(db.prepare('SELECT stock FROM buffet_items WHERE id=?').get(itemId).stock, 8);

  // stock guard: request more than available
  rr = await req(app, 'POST', P(s, `/sessions/${ses.id}/buffet`), { ...auth(s), body: { item_id: itemId, qty: 99 } });
  assert.equal(rr.status, 409);

  // stop — client-sent amounts are IGNORED; server computes from timestamps.
  // Rewind start again to a fixed 6327s window; recorded paused span still subtracts.
  db.prepare(`UPDATE play_sessions SET started_at=datetime('now','-6327 seconds') WHERE id=?`).run(ses.id);
  const pausedTotal = db.prepare(`SELECT paused_total_sec FROM play_sessions WHERE id=?`).get(ses.id).paused_total_sec;
  rr = await req(app, 'POST', P(s, `/sessions/${ses.id}/stop`), { ...auth(s), body: { total_cents: 1, duration_sec: 999999 } });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  const rec = rr.data.receipt;
  const dur = rec.duration_sec;
  const expectDur = 6327 - pausedTotal;
  assert.ok(Math.abs(dur - expectDur) <= 3, `duration≈${expectDur} (6327−paused ${pausedTotal}) got ` + dur);
  const expectGame = Math.floor(300000 * dur / 3600);
  assert.equal(rec.game_cents, expectGame, 'server-computed game cost (ignores client)');
  assert.equal(rec.buffet_cents, 50000, '2×25000');
  assert.equal(rec.total_cents, expectGame + 50000);
  assert.ok(rec.ended_at, 'end time recorded');
  assert.equal(rr.data.session.status, 'stopped');

  // system freed, sale row, history, audit
  rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.data.systems.find(x => x.id === sysId).status, 'available');
  const sale = db.prepare(`SELECT * FROM play_sales WHERE session_id=?`).get(ses.id);
  assert.ok(sale, 'sale recorded');
  assert.equal(sale.total_cents, expectGame + 50000);
  assert.equal(sale.game_cents, expectGame);
  const stopped = db.prepare(`SELECT * FROM play_sessions WHERE id=?`).get(ses.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.ended_by_name.length > 0, true, 'stopper recorded');
  assert.ok(stopped.started_by_name.length > 0, 'starter recorded');
  const audits = db.prepare(`SELECT action FROM audit_logs WHERE gamenet_id=? AND action LIKE 'play.%'`).all(s.gid).map(a => a.action);
  for(const a of ['play.system_create', 'play.tariff_create', 'play.session_start', 'play.session_pause', 'play.session_resume', 'play.buffet_add', 'play.session_stop'])
    assert.ok(audits.includes(a), 'audit has ' + a + ' — got: ' + audits.join(','));

  // history filter
  rr = await req(app, 'GET', P(s, '/sessions?status=stopped&system=PC-07'), auth(s));
  assert.equal(rr.status, 200);
  assert.equal(rr.data.total, 1);
  assert.equal(rr.data.sessions[0].public_id, rec.public_id);

  // dashboard aggregates (today)
  rr = await req(app, 'GET', P(s, '/dashboard'), auth(s));
  assert.equal(rr.status, 200);
  const d = rr.data;
  assert.equal(d.sessions_today, 1);
  assert.ok(d.game_revenue_today >= expectGame, 'game revenue today');
  assert.ok(d.per_system.some(r => r.system_number === 'PC-07'), 'per-system revenue');
  assert.ok(d.systems_available >= 1);
});

test('status transitions enforced server-side', async () => {
  const s = await ownerSetup('stat');
  await req(app, 'POST', P(s, '/tariffs'), { ...auth(s), body: { name: 'p', rate_per_hour: 100000 } });
  let rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'PS-01', type: 'playstation' } });
  const sysId = rr.data.system.id;

  // manual status: in_use / paused are NOT settable by hand
  rr = await req(app, 'PATCH', P(s, `/systems/${sysId}`), { ...auth(s), body: { status: 'in_use' } });
  assert.equal(rr.status, 400);
  // broken → cannot start
  rr = await req(app, 'PATCH', P(s, `/systems/${sysId}`), { ...auth(s), body: { status: 'broken' } });
  assert.equal(rr.status, 200);
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  assert.equal(rr.status, 409);
  // back to available → start, then status change blocked while session open
  await req(app, 'PATCH', P(s, `/systems/${sysId}`), { ...auth(s), body: { status: 'available' } });
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  assert.equal(rr.status, 201);
  rr = await req(app, 'PATCH', P(s, `/systems/${sysId}`), { ...auth(s), body: { status: 'reserved' } });
  assert.equal(rr.status, 409, 'status locked while session open');
  // duplicate system number → 409
  rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'ps-01', type: 'pc' } });
  assert.equal(rr.status, 409);
});

test('tenant isolation & role split: staff can run sessions, not catalogs', async () => {
  const owner = await ownerSetup('iso');
  await req(app, 'POST', P(owner, '/tariffs'), { ...auth(owner), body: { name: 'p', rate_per_hour: 100000 } });
  let rr = await req(app, 'POST', P(owner, '/systems'), { ...auth(owner), body: { number: 'PC-99', type: 'pc' } });
  const sysId = rr.data.system.id;

  // outsider
  const out = await req(app, 'POST', '/api/auth/register', { body: { email: `iso_${Date.now()}@t.local`, password: 'Passw0rd!x', name: 'Out' } });
  const oJar = cookieJar(out.setCookie), oCsrf = csrfOf(out.setCookie);
  rr = await req(app, 'GET', P(owner, '/live'), { cookie: oJar, headers: { 'x-csrf-token': oCsrf } });
  assert.equal(rr.status, 403, 'tenant isolation on /live');
  rr = await req(app, 'POST', P(owner, `/systems/${sysId}/start`), { cookie: oJar, headers: { 'x-csrf-token': oCsrf }, body: {} });
  assert.equal(rr.status, 403, 'outsider cannot start');

  // staff member: session ops OK, catalog mutations forbidden
  const st = await req(app, 'POST', '/api/auth/register', { body: { email: `st_${Date.now()}@t.local`, password: 'Passw0rd!x', name: 'Staff' } });
  const sJar = cookieJar(st.setCookie), sCsrf = csrfOf(st.setCookie);
  db.prepare(`INSERT INTO gamenet_members(gamenet_id,user_id,member_role) VALUES(?,?,'staff')`).run(owner.gid, st.data.user.id);
  const sAuth = { cookie: sJar, headers: { 'x-csrf-token': sCsrf } };
  rr = await req(app, 'POST', P(owner, `/systems/${sysId}/start`), { ...sAuth, body: {} });
  assert.equal(rr.status, 201, 'staff can start');
  rr = await req(app, 'POST', P(owner, `/sessions/${rr.data.session.id}/stop`), { ...sAuth, body: {} });
  assert.equal(rr.status, 200, 'staff can stop');
  rr = await req(app, 'POST', P(owner, '/tariffs'), { ...sAuth, body: { name: 'x', rate_per_hour: 1 } });
  assert.equal(rr.status, 403, 'staff cannot create tariffs');
  rr = await req(app, 'POST', P(owner, '/systems'), { ...sAuth, body: { number: 'X-1', type: 'pc' } });
  assert.equal(rr.status, 403, 'staff cannot create systems');
  rr = await req(app, 'POST', P(owner, '/buffet'), { ...sAuth, body: { name: 'چیپس', price_cents: 10000 } });
  assert.equal(rr.status, 403, 'staff cannot manage buffet catalog');
});

test('buffet line remove restores stock; closed session rejects edits', async () => {
  const s = await ownerSetup('buf');
  await req(app, 'POST', P(s, '/tariffs'), { ...auth(s), body: { name: 'p', rate_per_hour: 100000 } });
  let rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'PC-02', type: 'pc' } });
  const sysId = rr.data.system.id;
  rr = await req(app, 'POST', P(s, '/buffet'), { ...auth(s), body: { name: 'چیپس', price_cents: 15000, stock: 5 } });
  const itemId = rr.data.item.id;
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  const sid = rr.data.session.id;
  rr = await req(app, 'POST', P(s, `/sessions/${sid}/buffet`), { ...auth(s), body: { item_id: itemId, qty: 3 } });
  const lineId = rr.data.line_id;
  assert.equal(db.prepare('SELECT stock FROM buffet_items WHERE id=?').get(itemId).stock, 2);
  rr = await req(app, 'DELETE', P(s, `/sessions/${sid}/buffet/${lineId}`), auth(s));
  assert.equal(rr.status, 200);
  assert.equal(db.prepare('SELECT stock FROM buffet_items WHERE id=?').get(itemId).stock, 5, 'stock restored');
  // close, then edits rejected
  rr = await req(app, 'POST', P(s, `/sessions/${sid}/stop`), { ...auth(s), body: {} });
  assert.equal(rr.status, 200);
  rr = await req(app, 'POST', P(s, `/sessions/${sid}/buffet`), { ...auth(s), body: { item_id: itemId, qty: 1 } });
  assert.equal(rr.status, 409, 'closed session rejects buffet');
  rr = await req(app, 'POST', P(s, `/sessions/${sid}/stop`), { ...auth(s), body: {} });
  assert.equal(rr.status, 409, 'double stop rejected');
});


/* ── license gate ── */
test('license gate: no active license → 403 on every play endpoint', async () => {
  const s = await ownerSetup('nolic', { license: false });
  let rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 403, JSON.stringify(rr.data));
  assert.equal(rr.data.error, 'license_required');
  rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'PC-13', type: 'pc' } });
  assert.equal(rr.status, 403, 'cannot create systems without license');
  rr = await req(app, 'POST', P(s, '/tariffs'), { ...auth(s), body: { name: 'x', rate_per_hour: 1000 } });
  assert.equal(rr.status, 403, 'cannot create tariffs without license');
  rr = await req(app, 'GET', P(s, '/storage'), auth(s));
  assert.equal(rr.status, 403, 'storage/invoices locked too');
  rr = await req(app, 'GET', P(s, '/dashboard'), auth(s));
  assert.equal(rr.status, 403, 'dashboard stats locked too');
});

/* ── admin license events ── */
test('admin license event: grant free 1-month → use → deactivate revokes', async () => {
  const s = await ownerSetup('evt', { license: false });

  // platform admin logs in (seeded credentials)
  const ad = await req(app, 'POST', '/api/auth/login', { body: { email: 'admin@gamenet.local', password: 'Admin@12345' } });
  assert.equal(ad.status, 200, JSON.stringify(ad.data));
  assert.ok(ad.data.user.roles.some(r => r === 'admin' || r === 'super_admin'));
  const aJar = cookieJar(ad.setCookie), aCsrf = csrfOf(ad.setCookie);
  const aAuth = { cookie: aJar, headers: { 'x-csrf-token': aCsrf } };

  // still locked before the event
  let rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 403);

  // create event (default = 30 days = one month)
  rr = await req(app, 'POST', '/api/admin/license-events', { ...aAuth, body: { name: 'جشنواره تست' } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const ev = rr.data.event;
  assert.equal(ev.duration_days, 30, 'default one month');
  assert.equal(ev.active, 1);

  // issue free license to the gamenet
  rr = await req(app, 'POST', `/api/admin/license-events/${ev.id}/issue`, { ...aAuth, body: { gamenet_id: s.gid } });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const lic = rr.data.license;
  assert.equal(lic.status, 'active');
  assert.equal(lic.event_id, ev.id);
  const daysLeft = (Date.parse(lic.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
  assert.ok(daysLeft > 29 && daysLeft <= 30.1, '≈30 days, got ' + daysLeft);

  // now the play subsystem unlocks
  rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 200, 'unlocked after event issue');

  // deactivate event → its license revokes → locked again
  rr = await req(app, 'POST', `/api/admin/license-events/${ev.id}/status`, { ...aAuth, body: { active: false } });
  assert.equal(rr.status, 200);
  assert.equal(rr.data.revoked, 1, 'one license revoked');
  assert.equal(rr.data.event.active, 0);
  rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 403, 'locked after deactivation');

  // reactivate event (can grant again) + re-issue → unlocked
  rr = await req(app, 'POST', `/api/admin/license-events/${ev.id}/status`, { ...aAuth, body: { active: true } });
  assert.equal(rr.data.event.active, 1);
  rr = await req(app, 'POST', `/api/admin/license-events/${ev.id}/issue`, { ...aAuth, body: { gamenet_id: s.gid } });
  assert.equal(rr.status, 201);
  rr = await req(app, 'GET', P(s, '/live'), auth(s));
  assert.equal(rr.status, 200);

  // issuing while event inactive → 409
  await req(app, 'POST', `/api/admin/license-events/${ev.id}/status`, { ...aAuth, body: { active: false } });
  rr = await req(app, 'POST', `/api/admin/license-events/${ev.id}/issue`, { ...aAuth, body: { gamenet_id: s.gid } });
  assert.equal(rr.status, 409);

  // regular customers cannot manage events
  rr = await req(app, 'POST', '/api/admin/license-events', { ...auth(s), body: { name: 'x' } });
  assert.equal(rr.status, 403, 'non-admin cannot create events');
});

/* ── repurposed storage + invoices ── */
test('storage endpoint reports settings data + saved game invoices', async () => {
  const s = await ownerSetup('store');
  await req(app, 'POST', P(s, '/tariffs'), { ...auth(s), body: { name: 'p', rate_per_hour: 100000 } });
  let rr = await req(app, 'POST', P(s, '/systems'), { ...auth(s), body: { number: 'PC-77', type: 'pc' } });
  const sysId = rr.data.system.id;
  rr = await req(app, 'POST', P(s, '/buffet'), { ...auth(s), body: { name: 'ساندویچ', price_cents: 80000, stock: 3 } });
  const itemId = rr.data.item.id;
  rr = await req(app, 'POST', P(s, `/systems/${sysId}/start`), { ...auth(s), body: {} });
  const sid = rr.data.session.id;
  await req(app, 'POST', P(s, `/sessions/${sid}/buffet`), { ...auth(s), body: { item_id: itemId, qty: 1 } });
  rr = await req(app, 'POST', P(s, `/sessions/${sid}/stop`), { ...auth(s), body: {} });
  assert.equal(rr.status, 200);

  rr = await req(app, 'GET', P(s, '/storage'), auth(s));
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  const d = rr.data;
  assert.ok(d.used_bytes > 0, 'settings+invoice bytes counted');
  assert.ok(d.limit_bytes > 0, 'quota from gamenet');
  assert.equal(d.counts.systems, 1);
  assert.equal(d.counts.tariffs, 1);
  assert.equal(d.counts.buffet_items, 1);
  assert.equal(d.counts.sessions, 1);
  assert.equal(d.counts.invoices, 1, 'game invoice saved');
  assert.equal(d.invoices.length, 1, 'invoice list returned');
  assert.ok(d.invoices[0].total_cents > 0);
  assert.ok(d.invoices[0].public_id, 'invoice linked to session facture id');
  assert.ok(d.breakdown.some(b => b.kind === 'invoices' && b.bytes > 0));
});
