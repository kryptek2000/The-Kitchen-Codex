/**
 * OIDC ID-token verification for Sign in with ChatGPT.
 *
 * Open-source public client: no client secret. The ID token is verified against
 * OpenAI's published JWKS, issuer, audience (issued client ID), nonce, and
 * lifetime before any account state is accepted.
 */

'use strict';

const crypto = require('node:crypto');

const MAX_TOKEN_LENGTH = 100_000;

function decodePart(part, label) {
  try {
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} is not a JSON object.`);
    }
    return parsed;
  } catch {
    throw new Error(`ID token ${label} is malformed.`);
  }
}

function decodeJwt(token) {
  const raw = String(token || '');
  if (!raw || raw.length > MAX_TOKEN_LENGTH) throw new Error('ID token is missing or oversized.');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('ID token must have three segments.');
  const header = decodePart(parts[0], 'header');
  const payload = decodePart(parts[1], 'payload');
  if (header.crit !== undefined) throw new Error('ID token uses unsupported critical headers.');
  return {
    raw,
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function selectKey(jwks, kid, alg) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const usable = keys.filter((key) => {
    if (!key || typeof key !== 'object') return false;
    if (key.use && key.use !== 'sig') return false;
    if (key.alg && key.alg !== alg) return false;
    if (kid && key.kid !== kid) return false;
    return Boolean(key.kty);
  });
  if (usable.length === 1) return usable[0];
  if (kid) {
    const match = usable.find((key) => key.kid === kid);
    if (match) return match;
  }
  return null;
}

function verifySignature(decoded, jwk) {
  const alg = decoded.header.alg;
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new Error('ID token signing key could not be loaded.');
  }

  let verified = false;
  if (alg === 'RS256') {
    verified = crypto.verify('RSA-SHA256', Buffer.from(decoded.signingInput), key, decoded.signature);
  } else if (alg === 'ES256') {
    verified = crypto.verify(
      'sha256',
      Buffer.from(decoded.signingInput),
      { key, dsaEncoding: 'ieee-p1363' },
      decoded.signature
    );
  } else {
    throw new Error(`ID token algorithm ${String(alg)} is not accepted.`);
  }
  if (!verified) throw new Error('ID token signature is invalid.');
}

function numericDate(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`ID token ${label} claim is missing or invalid.`);
  }
  return value;
}

function verifyIdToken({
  token,
  jwks,
  issuer,
  audience,
  nonce,
  expectedSubject,
  now = Math.floor(Date.now() / 1000),
  clockSkewSeconds = 60,
}) {
  const decoded = decodeJwt(token);
  const alg = decoded.header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') {
    throw new Error('ID token uses an unsupported algorithm.');
  }
  const key = selectKey(jwks, decoded.header.kid, alg);
  if (!key) throw new Error('ID token signing key was not found.');

  verifySignature(decoded, key);

  const claims = decoded.payload;
  if (claims.iss !== issuer) throw new Error('ID token issuer does not match.');
  const audienceValues = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    audienceValues.length === 0 ||
    audienceValues.some((value) => typeof value !== 'string' || !value) ||
    !audienceValues.includes(audience)
  ) {
    throw new Error('ID token audience does not match.');
  }
  // OIDC requires azp when aud names more than one audience. Without it, the
  // token cannot prove that this dynamically registered client is the intended
  // authorized party, even if its client_id appears in aud.
  if (
    (audienceValues.length > 1 && (typeof claims.azp !== 'string' || !claims.azp)) ||
    (claims.azp !== undefined && claims.azp !== audience)
  ) {
    throw new Error('ID token authorized party does not match.');
  }
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('ID token nonce does not match.');
  if (nonce !== undefined && !claims.nonce) throw new Error('ID token nonce is missing.');

  const skew = Math.max(0, Number(clockSkewSeconds) || 0);
  const exp = numericDate(claims.exp, 'exp');
  if (exp <= now - skew) throw new Error('ID token has expired.');
  if (typeof claims.iat === 'number' && claims.iat > now + skew) {
    throw new Error('ID token issued-at time is in the future.');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now + skew) {
    throw new Error('ID token is not valid yet.');
  }

  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 512) {
    throw new Error('ID token subject is missing or invalid.');
  }
  if (expectedSubject !== undefined && claims.sub !== expectedSubject) {
    throw new Error('ID token subject does not match the selected account.');
  }
  if (claims.email !== undefined && (typeof claims.email !== 'string' || claims.email.length > 320)) {
    throw new Error('ID token email claim is invalid.');
  }

  return claims;
}

module.exports = {
  MAX_TOKEN_LENGTH,
  decodeJwt,
  selectKey,
  verifyIdToken,
};
