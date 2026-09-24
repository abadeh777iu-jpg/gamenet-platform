'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');

async function signup(prefix){
  const email = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,6)}@test.local`;
  const r = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: prefix } });
  assert.equal(r.status, 201);
  return { jar: cookieJar(r.setCookie), csrf: csrfOf(r.setCookie), email };
}

test('TENANT A cannot access TENANT B data', async () => {
  const A = await signup('alice');
  const B = await signup('bob');

  // A creates gamenet
  const g = await req(app, 'POST', '/api/gamenets', {
    cookie: A.jar, headers: { 'x-csrf-token': A.csrf }, body: { name: 'Alice Club' }
  });
  assert.equal(g.status, 201);
  const gid = g.data.gamenet.id;

  // A can read
  const ok = await req(app, 'GET', `/api/gamenets/${gid}`, { cookie: A.jar });
  assert.equal(ok.status, 200);

  // B CANNOT read A's tenant
  const deny = await req(app, 'GET', `/api/gamenets/${gid}`, { cookie: B.jar });
  assert.equal(deny.status, 403);
  assert.equal(deny.data.error, 'tenant_forbidden');

  // B cannot list files of A
  const files = await req(app, 'GET', `/api/gamenets/${gid}/files`, { cookie: B.jar });
  assert.equal(files.status, 403);

  // B cannot create ticket on A's tenant
  const tk = await req(app, 'POST', `/api/gamenets/${gid}/tickets`, {
    cookie: B.jar, headers: { 'x-csrf-token': B.csrf }, body: { subject: 'hack' }
  });
  assert.equal(tk.status, 403);

  // B cannot see A's subscription
  const sub = await req(app, 'GET', `/api/subscriptions/gamenets/${gid}/subscription`, { cookie: B.jar });
  assert.equal(sub.status, 403);

  // B cannot update A's tenant
  const up = await req(app, 'PUT', `/api/gamenets/${gid}`, {
    cookie: B.jar, headers: { 'x-csrf-token': B.csrf }, body: { name: 'hacked' }
  });
  assert.equal(up.status, 403);

  // Admin can see all (platform role)
  const admin = await req(app, 'POST', '/api/auth/login', { body: { email: 'admin@gamenet.local', password: 'Admin@12345' } });
  assert.equal(admin.status, 200);
  const adminJar = cookieJar(admin.setCookie);
  const adminView = await req(app, 'GET', `/api/admin/gamenets/${gid}/overview`, { cookie: adminJar });
  assert.equal(adminView.status, 200);

  // AI tool for B with A's gamenet_id must be denied
  const ai = await req(app, 'POST', '/api/ai/chat', {
    cookie: B.jar, headers: { 'x-csrf-token': B.csrf },
    body: { message: 'وضعیت اشتراک', gamenet_id: gid }
  });
  assert.equal(ai.status, 403);
});
