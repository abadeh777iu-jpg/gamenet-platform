'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runTool, listToolDefs } = require('../src/services/ai/tools');
const { app, req, cookieJar, csrfOf } = require('./helpers');

test('AI tool layer blocks cross-tenant access', async () => {
  const ts = Date.now();
  const aEmail = `aiA_${ts}@t.local`;
  const bEmail = `aiB_${ts}@t.local`;
  const ra = await req(app, 'POST', '/api/auth/register', { body: { email: aEmail, password: 'Passw0rd!x', name: 'A' } });
  assert.equal(ra.status, 201, JSON.stringify(ra.data));
  const rb = await req(app, 'POST', '/api/auth/register', { body: { email: bEmail, password: 'Passw0rd!x', name: 'B' } });
  assert.equal(rb.status, 201, JSON.stringify(rb.data));
  const jarA = cookieJar(ra.setCookie), csrfA = csrfOf(ra.setCookie);
  const jarB = cookieJar(rb.setCookie), csrfB = csrfOf(rb.setCookie);

  const g = await req(app, 'POST', '/api/gamenets', {
    cookie: jarA, headers: { 'x-csrf-token': csrfA },
    body: { name: 'AI Club ' + ts, slug: 'ai-club-' + ts },
  });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  const gid = g.data.gamenet.id;

  // direct tool: B not member → denied
  const denied = runTool('get_subscription_status', { userId: rb.data.user.id, roles: ['owner'], gamenetId: gid });
  assert.ok(denied.error === 'TENANT_DENIED' || denied.status === 403 || denied.error);

  // A member → not TENANT_DENIED
  const allowed = runTool('get_subscription_status', { userId: ra.data.user.id, roles: ['owner'], gamenetId: gid });
  assert.notEqual(allowed.error, 'TENANT_DENIED');

  // allowlisted tools only
  const names = listToolDefs().map(t => t.name);
  assert.ok(names.includes('get_storage_status'));
  assert.ok(!names.some(n => /sql|exec|fs|raw_query/.test(n)));

  // AI chat B → 403
  const ai = await req(app, 'POST', '/api/ai/chat', {
    cookie: jarB, headers: { 'x-csrf-token': csrfB },
    body: { message: 'چه خبر؟', gamenet_id: gid },
  });
  assert.equal(ai.status, 403);

  // AI chat A → 200 scoped reply
  const aiOk = await req(app, 'POST', '/api/ai/chat', {
    cookie: jarA, headers: { 'x-csrf-token': csrfA },
    body: { message: 'وضعیت اشتراک من چیست؟', gamenet_id: gid },
  });
  assert.equal(aiOk.status, 200);
  assert.ok(typeof aiOk.data.reply === 'string' && aiOk.data.reply.length > 0);
});
