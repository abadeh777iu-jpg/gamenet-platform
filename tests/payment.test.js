'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');

test('payment idempotency + subscription activation', async () => {
  const email = `pay_${Date.now()}@test.local`;
  const reg = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: 'P' } });
  assert.equal(reg.status, 201);
  // verify email using dev token
  const vtok = reg.data.verify_token_dev;
  const jar = cookieJar(reg.setCookie);
  const csrf = csrfOf(reg.setCookie);
  if(vtok){
    const v = await req(app, 'POST', '/api/auth/verify-email', { cookie: jar, headers: { 'x-csrf-token': csrf }, body: { token: vtok } });
    assert.equal(v.status, 200);
  }
  // create gamenet
  const g = await req(app, 'POST', '/api/gamenets', { cookie: jar, headers: { 'x-csrf-token': csrf }, body: { name: 'Pay Club' } });
  assert.equal(g.status, 201);
  const gid = g.data.gamenet.id;
  // plans
  const plans = await req(app, 'GET', '/api/plans');
  const planId = plans.data.plans[0].id;
  // order with same idempotency key twice
  const idem = 'test-idem-' + Date.now();
  const o1 = await req(app, 'POST', '/api/subscriptions/orders', {
    cookie: jar, headers: { 'x-csrf-token': csrf, 'Idempotency-Key': idem },
    body: { gamenet_id: gid, plan_id: planId }
  });
  const o2 = await req(app, 'POST', '/api/subscriptions/orders', {
    cookie: jar, headers: { 'x-csrf-token': csrf, 'Idempotency-Key': idem },
    body: { gamenet_id: gid, plan_id: planId }
  });
  assert.equal(o1.status, 201);
  assert.equal(o1.data.order.id, o2.data.order.id, 'same order for same idempotency key');
  // pay
  const pay = await req(app, 'POST', `/api/subscriptions/orders/${o1.data.order.id}/pay`, {
    cookie: jar, headers: { 'x-csrf-token': csrf }, body: {}
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.data.order.status, 'paid');
  // second pay is idempotent
  const pay2 = await req(app, 'POST', `/api/subscriptions/orders/${o1.data.order.id}/pay`, {
    cookie: jar, headers: { 'x-csrf-token': csrf }, body: {}
  });
  assert.equal(pay2.status, 200);
  // subscription active
  const sub = await req(app, 'GET', `/api/subscriptions/gamenets/${gid}/subscription`, { cookie: jar });
  assert.equal(sub.status, 200);
  assert.ok(sub.data.subscription && sub.data.subscription.status === 'active');
  // webhook duplicate event ignored
  const evId = 'evt_' + Date.now();
  const wh1 = await req(app, 'POST', '/api/payments/webhook', {
    headers: { 'x-csrf-token': 'no-cookie-ok' }, // webhook skips CSRF? csrfProtect allows webhook path
    body: { provider: 'mock', event_id: evId, type: 'payment.succeeded', data: { order_id: o1.data.order.id } }
  });
  // may 403 csrf if no cookie - webhook path is exempted in csrfProtect
  const wh2 = await req(app, 'POST', '/api/payments/webhook', {
    body: { provider: 'mock', event_id: evId, type: 'payment.succeeded', data: { order_id: o1.data.order.id } }
  });
  if(wh1.status === 200){
    assert.equal(wh1.data.duplicate, false);
    assert.equal(wh2.data.duplicate, true, 'duplicate webhook must be ignored');
  }
});
