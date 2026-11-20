/**
 * PKCE S256, state, and nonce helpers for Sign in with ChatGPT.
 */

'use strict';

const crypto = require('node:crypto');

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function challengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(String(verifier), 'utf8').digest());
}

function createPkce(verifier = randomToken(64)) {
  const normalized = String(verifier);
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(normalized)) {
    throw new Error('PKCE verifier is outside the RFC 7636 length/character bounds.');
  }
  return {
    verifier: normalized,
    challenge: challengeFor(normalized),
    method: 'S256',
  };
}

function equalSecret(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  base64url,
  challengeFor,
  createPkce,
  equalSecret,
  randomToken,
};
