import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChaosError } from './errors.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function mac(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

export function signHs256(payload, secret) {
  const body = `${HEADER}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(mac(body, secret))}`;
}

const invalid = (m) => new ChaosError('TOKEN_INVALID', m, 401);

/** Verifies signature and algorithm only; claim checks belong to callers. */
export function verifyHs256(token, secret) {
  if (typeof token !== 'string' || token.length > 4096) throw invalid('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('malformed token');
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw invalid('malformed token');
  }
  if (header?.alg !== 'HS256') throw invalid('only HS256 is accepted');
  const expected = mac(`${h}.${p}`, secret);
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalid('bad signature');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid('malformed payload');
  }
  return payload;
}
