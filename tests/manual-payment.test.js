'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { app, req, cookieJar, csrfOf } = require('./helpers');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setupUser(tag){
  const email = `${tag}_${Date.now()}@test.local`;
  const reg = await req(app, 'POST', '/api/auth/register', { body: { email, password: 'Passw0rd!x', name: tag } });
  assert.equal(reg.status, 201);
  const jar = cookieJar(reg.setCookie);
  const csrf = csrfOf(reg.setCookie);
  const g = await req(app, 'POST', '/api/gamenets', { cookie: jar, headers: { 'x-csrf-token': csrf }, body: { name: tag + ' Club' } });
  assert.equal(g.status, 201);
  const plans = await req(app, 'GET', '/api/plans');
  const order = await req(app, 'POST', '/api/subscriptions/orders', {
    cookie: jar, headers: { 'x-csrf-token': csrf, 'Idempotency-Key': 'mp-' + Date.now() + '-' + tag },
    body: { gamenet_id: g.data.gamenet.id, plan_id: plans.data.plans[0].id },
  });
  assert.equal(order.status, 201);
  return { email, jar, csrf, gid: g.data.gamenet.id, orderId: order.data.order.id };
}

test('manual card-to-card: submit → admin confirm activates sub+license; reject reopens', async () => {
  const c = await setupUser('mp');

  // payment page data
  const pg = await req(app, 'GET', `/api/subscriptions/orders/${c.orderId}/payment`, { cookie: c.jar });
  assert.equal(pg.status, 200);
  assert.ok(pg.data.order);
  assert.ok(pg.data.card);

  // invalid tracking rejected
  const bad = await req(app, 'POST', `/api/subscriptions/orders/${c.orderId}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf }, body: { tracking_code: '12' } });
  assert.equal(bad.status, 400);

  // invalid receipt rejected (non-image payload)
  const badR = await req(app, 'POST', `/api/subscriptions/orders/${c.orderId}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf },
    body: { tracking_code: '9876543210', receipt: 'data:text/html;base64,PHNjcmlwdD4=' } });
  assert.equal(badR.status, 400);

  // valid submission
  const sub = await req(app, 'POST', `/api/subscriptions/orders/${c.orderId}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf },
    body: { tracking_code: '987654321098765', receipt: TINY_PNG } });
  assert.equal(sub.status, 201);
  assert.equal(sub.data.payment.status, 'pending');

  // order flipped to pending, NOT paid (nobody can self-activate)
  const pg2 = await req(app, 'GET', `/api/subscriptions/orders/${c.orderId}/payment`, { cookie: c.jar });
  assert.equal(pg2.data.order.status, 'pending');
  assert.equal(pg2.data.payment.status, 'pending');
  assert.equal(pg2.data.payment.tracking_code, '987654321098765');
  assert.equal(pg2.data.payment.has_receipt, true);

  // subscription still inactive
  const s0 = await req(app, 'GET', `/api/subscriptions/gamenets/${c.gid}/subscription`, { cookie: c.jar });
  assert.ok(!s0.data.subscription || s0.data.subscription.status !== 'active');

  // IDOR: another customer cannot read this order's payment page
  const other = await setupUser('other');
  const idor = await req(app, 'GET', `/api/subscriptions/orders/${c.orderId}/payment`, { cookie: other.jar });
  assert.equal(idor.status, 404);

  // customer cannot confirm their own payment
  const selfConfirm = await req(app, 'POST', `/api/admin/payments/${sub.data.payment.id}/confirm`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf }, body: {} });
  assert.equal(selfConfirm.status, 403);

  // mock /pay is a no-go once paid-pending? (non-prod helper skips pending manual — it force-pays; not used by UI)

  // ADMIN login and confirm
  const adm = await req(app, 'POST', '/api/auth/login', { body: { email: 'admin@gamenet.local', password: 'Admin@12345' } });
  assert.equal(adm.status, 200);
  const aj = cookieJar(adm.setCookie);
  const ac = csrfOf(adm.setCookie);

  const list = await req(app, 'GET', '/api/admin/payments', { cookie: aj });
  assert.equal(list.status, 200);
  const mine = list.data.payments.find(p => p.id === sub.data.payment.id);
  assert.ok(mine, 'admin sees the pending payment');
  assert.equal(mine.status, 'pending');

  const conf = await req(app, 'POST', `/api/admin/payments/${sub.data.payment.id}/confirm`, {
    cookie: aj, headers: { 'x-csrf-token': ac }, body: {} });
  assert.equal(conf.status, 200);
  assert.equal(conf.data.order.status, 'paid');

  // idempotent confirm
  const conf2 = await req(app, 'POST', `/api/admin/payments/${sub.data.payment.id}/confirm`, {
    cookie: aj, headers: { 'x-csrf-token': ac }, body: {} });
  assert.equal(conf2.status, 200);
  assert.equal(conf2.data.alreadyConfirmed, true);

  // subscription + license now active for the customer
  const s1 = await req(app, 'GET', `/api/subscriptions/gamenets/${c.gid}/subscription`, { cookie: c.jar });
  assert.ok(s1.data.subscription && s1.data.subscription.status === 'active');
  const lic = s1.data.licenses.find(l => l.status === 'active');
  assert.ok(lic, 'license issued and active');

  // paid order cannot be resubmitted
  const again = await req(app, 'POST', `/api/subscriptions/orders/${c.orderId}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf }, body: { tracking_code: '11111222223333' } });
  assert.equal(again.status, 409);

  // REJECT path: second order → submit → reject → order reopens
  const plans = await req(app, 'GET', '/api/plans');
  const o2 = await req(app, 'POST', '/api/subscriptions/orders', {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf, 'Idempotency-Key': 'mp2-' + Date.now() },
    body: { gamenet_id: c.gid, plan_id: plans.data.plans[0].id } });
  assert.equal(o2.status, 201);
  const sub2 = await req(app, 'POST', `/api/subscriptions/orders/${o2.data.order.id}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf }, body: { tracking_code: '555556666677777' } });
  assert.equal(sub2.status, 201);
  const rej = await req(app, 'POST', `/api/admin/payments/${sub2.data.payment.id}/reject`, {
    cookie: aj, headers: { 'x-csrf-token': ac }, body: { reason: 'مبلغ واریزی کمتر از سقف بود' } });
  assert.equal(rej.status, 200);
  const pg3 = await req(app, 'GET', `/api/subscriptions/orders/${o2.data.order.id}/payment`, { cookie: c.jar });
  assert.equal(pg3.data.order.status, 'created');
  assert.equal(pg3.data.payment.status, 'failed');
  // customer can resubmit after rejection
  const sub3 = await req(app, 'POST', `/api/subscriptions/orders/${o2.data.order.id}/submit-payment`, {
    cookie: c.jar, headers: { 'x-csrf-token': c.csrf }, body: { tracking_code: '999998888877777' } });
  assert.equal(sub3.status, 201);
});

test('public payment config endpoint serves card instructions', async () => {
  const r = await req(app, 'GET', '/api/payment-config');
  assert.equal(r.status, 200);
  assert.ok(r.data.card);
  assert.ok('card_number' in r.data.card);
});
