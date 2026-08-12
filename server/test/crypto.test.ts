import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MAILWAY_DATA_DIR = process.env.MAILWAY_DATA_DIR || '/tmp/mailway-test-data';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  newApiKey,
  verifyPassword,
} from '../src/core/crypto';

test('hashPassword/verifyPassword aceptan la correcta y rechazan la incorrecta', () => {
  const hash = hashPassword('contraseña-larga-123');
  assert.equal(verifyPassword('contraseña-larga-123', hash), true);
  assert.equal(verifyPassword('otra', hash), false);
});

test('verifyPassword no revienta con formato inválido', () => {
  assert.equal(verifyPassword('x', 'basura'), false);
  assert.equal(verifyPassword('x', 'scrypt:solo-dos'), false);
});

test('encryptSecret/decryptSecret es reversible y no expone el texto', () => {
  const secret = 'mw-app-password-24chars-secret';
  const enc = encryptSecret(secret);
  assert.notEqual(enc, secret);
  assert.ok(!enc.includes(secret));
  assert.equal(decryptSecret(enc), secret);
});

test('decryptSecret rechaza un formato desconocido', () => {
  assert.throws(() => decryptSecret('v9:aa:bb:cc'));
});

test('newApiKey produce prefijo enlazable y hash verificable', () => {
  const { key, prefix, hash } = newApiKey();
  assert.match(key, /^mw_[0-9a-f]{8}_[A-Za-z0-9_-]+$/);
  assert.equal(key.split('_')[1], prefix);
  assert.equal(hashToken(key), hash);
  assert.notEqual(hashToken(key + 'x'), hash);
});
