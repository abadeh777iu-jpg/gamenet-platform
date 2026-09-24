'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/services/password');
const { publicId, sha256, licenseKey } = require('../src/services/ids');
const { signAccess, verifyAccess } = require('../src/services/jwt');

test('password hash/verify', () => {
  const h = hashPassword('Secret#123');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('Secret#123', h), true);
  assert.equal(verifyPassword('Wrong#123', h), false);
});
test('short password rejected', () => {
  assert.throws(() => hashPassword('123'));
});
test('ids unique', () => {
  assert.notEqual(publicId('x'), publicId('x'));
  assert.ok(licenseKey().startsWith('GN-'));
});
test('jwt sign/verify', () => {
  const t = signAccess({ id: 1, roles: ['owner'] });
  const p = verifyAccess(t);
  assert.equal(p.sub, 1);
  assert.deepEqual(p.roles, ['owner']);
  const tampered = t.slice(0, -3) + 'aaa';
  assert.equal(verifyAccess(tampered), null);
});
