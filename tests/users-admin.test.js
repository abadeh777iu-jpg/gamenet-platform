'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');

let adminJar = '', adminCsrf = '';

before(async () => {
  const r = await req(app, 'POST', '/api/auth/login', { body: { email: 'admin@gamenet.local', password: 'Admin@12345' } });
  assert.equal(r.status, 200);
  adminJar = cookieJar(r.setCookie);
  adminCsrf = csrfOf(r.setCookie);
});

async function registerUser(tag) {
  const email = `uadm_${tag}_${Date.now()}@test.local`;
  const r = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: 'U ' + tag } });
  assert.equal(r.status, 201);
  const jar = cookieJar(r.setCookie);
  const me = await req(app, 'GET', '/api/auth/me', { cookie: jar });
  assert.equal(me.status, 200);
  return { email, jar, id: me.data.user.id };
}

function adminPost(path, body) {
  return req(app, 'POST', path, { cookie: adminJar, headers: { 'x-csrf-token': adminCsrf }, body });
}

test('users list: three categories with counts + status filter', async () => {
  const u = await registerUser('tabs');
  const r = await req(app, 'GET', '/api/admin/users?status=active', { cookie: adminJar });
  assert.equal(r.status, 200);
  assert.ok(r.data.counts && typeof r.data.counts.active === 'number' && typeof r.data.counts.suspended === 'number' && typeof r.data.counts.deleted === 'number');
  assert.ok(r.data.users.some(x => x.id === u.id && x.status === 'active'));
  const bad = await req(app, 'GET', '/api/admin/users?status=hacked', { cookie: adminJar });
  assert.equal(bad.status, 400);
});

test('suspend: login blocked, old session dead, shown in inactive tab', async () => {
  const u = await registerUser('sus');
  const s = await adminPost(`/api/admin/users/${u.id}/status`, { status: 'suspended' });
  assert.equal(s.status, 200);
  assert.equal(s.data.status, 'suspended');
  // old session immediately dead
  const me = await req(app, 'GET', '/api/auth/me', { cookie: u.jar });
  assert.equal(me.status, 401);
  // new login blocked
  const li = await req(app, 'POST', '/api/auth/login', { body: { email: u.email, password: 'Passw0rd!x' } });
  assert.equal(li.status, 403);
  assert.equal(li.data.error, 'account_suspended');
  // appears in inactive tab, not active
  const inact = await req(app, 'GET', '/api/admin/users?status=suspended', { cookie: adminJar });
  assert.ok(inact.data.users.some(x => x.id === u.id));
  const act = await req(app, 'GET', '/api/admin/users?status=active', { cookie: adminJar });
  assert.ok(!act.data.users.some(x => x.id === u.id));
  assert.ok(inact.data.counts.suspended >= 1);
});

test('delete (soft): hidden from active, login blocked, restorable', async () => {
  const u = await registerUser('del');
  const d = await adminPost(`/api/admin/users/${u.id}/status`, { status: 'deleted' });
  assert.equal(d.status, 200);
  assert.equal(d.data.status, 'deleted');
  const li = await req(app, 'POST', '/api/auth/login', { body: { email: u.email, password: 'Passw0rd!x' } });
  assert.equal(li.status, 403);
  const del = await req(app, 'GET', '/api/admin/users?status=deleted', { cookie: adminJar });
  assert.ok(del.data.users.some(x => x.id === u.id && x.status === 'deleted'));
  const act = await req(app, 'GET', '/api/admin/users?status=active', { cookie: adminJar });
  assert.ok(!act.data.users.some(x => x.id === u.id));
  // restore → works again
  const back = await adminPost(`/api/admin/users/${u.id}/status`, { status: 'active' });
  assert.equal(back.status, 200);
  const li2 = await req(app, 'POST', '/api/auth/login', { body: { email: u.email, password: 'Passw0rd!x' } });
  assert.equal(li2.status, 200);
});

test('guards: cannot change self, unknown user 404, bad status 400, non-admin 403', async () => {
  const adminMe = await req(app, 'GET', '/api/auth/me', { cookie: adminJar });
  const adminId = adminMe.data.user.id;
  const self = await adminPost(`/api/admin/users/${adminId}/status`, { status: 'deleted' });
  assert.equal(self.status, 400);
  assert.equal(self.data.error, 'cannot_change_self');
  const nf = await adminPost('/api/admin/users/999999/status', { status: 'suspended' });
  assert.equal(nf.status, 404);
  const u = await registerUser('guard');
  const bs = await adminPost(`/api/admin/users/${u.id}/status`, { status: 'nope' });
  assert.equal(bs.status, 400);
  const notAdmin = await req(app, 'GET', '/api/admin/users?status=active', { cookie: u.jar });
  assert.equal(notAdmin.status, 403);
});
