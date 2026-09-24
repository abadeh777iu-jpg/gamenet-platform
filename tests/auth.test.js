'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');

test('register + login + me + logout', async () => {
  const email = `user_${Date.now()}@test.local`;
  const r1 = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: 'T' } });
  assert.equal(r1.status, 201);
  const jar = cookieJar(r1.setCookie);
  const r2 = await req(app, 'GET', '/api/auth/me', { cookie: jar });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.user.email, email);
  const r3 = await req(app, 'POST', '/api/auth/logout', { cookie: jar, headers: { 'x-csrf-token': csrfOf(r1.setCookie) }, body: {} });
  assert.equal(r3.status, 200);
});

test('wrong password rejected', async () => {
  const r = await req(app, 'POST', '/api/auth/login', { body: { email: 'nobody@x.local', password: 'nope12345' } });
  assert.equal(r.status, 401);
});

test('weak password rejected', async () => {
  const r = await req(app, 'POST', '/api/auth/register', { body: { email: `w_${Date.now()}@t.local`, password: '123' } });
  assert.equal(r.status, 400);
});
