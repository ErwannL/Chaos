import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/auth.js';
import { signHs256, verifyHs256 } from '../src/jwt.js';

const SSO = 's'.repeat(40);
const SESSION = 'k'.repeat(40);
const ssoEnv = {
  CHAOS_SSO_SECRET: SSO,
  CHAOS_SESSION_SECRET: SESSION,
  CHAOS_SSO_ISSUERS: 'admin-console, other',
};
const localEnv = { CHAOS_LOCAL_USER: 'admin', CHAOS_LOCAL_PASSWORD: 'correct horse battery' };

describe('config', () => {
  it('defaults to loopback and resolves paths', () => {
    const c = loadConfig(localEnv, '/srv');
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 8090,
      dataDir: resolve('/srv/data'),
      webDir: null,
    });
    expect(c.auth.mode).toBe('local');
    expect(c.auth.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({ ...localEnv, CHAOS_WEB_DIR: 'web' }, '/srv').webDir).toBe(
      resolve('/srv/web'),
    );
  });

  it.each([
    [{ ...localEnv, CHAOS_HOST: '0.0.0.0' }, /loopback/],
    [{ ...localEnv, CHAOS_PORT: 'x' }, /CHAOS_PORT/],
    [{}, /CHAOS_LOCAL_USER/],
    [{ CHAOS_LOCAL_USER: 'a', CHAOS_LOCAL_PASSWORD: 'short' }, />= 12/],
    [{ ...ssoEnv, CHAOS_SSO_SECRET: 'short' }, /CHAOS_SSO_SECRET must be >= 32/],
    [{ ...ssoEnv, CHAOS_SESSION_SECRET: undefined }, /CHAOS_SESSION_SECRET is required/],
    [{ ...ssoEnv, CHAOS_SESSION_SECRET: 'short' }, /CHAOS_SESSION_SECRET must be >= 32/],
    [{ ...ssoEnv, CHAOS_SESSION_SECRET: SSO }, /must differ/],
    [{ ...ssoEnv, CHAOS_SSO_ISSUERS: ' ' }, /CHAOS_SSO_ISSUERS/],
    [{ ...ssoEnv, CHAOS_SSO_ISSUERS: undefined }, /CHAOS_SSO_ISSUERS/],
  ])('refuses invalid config %#', (env, re) => {
    expect(() => loadConfig(env)).toThrow(re);
  });

  it('enables SSO with issuers', () => {
    expect(loadConfig(ssoEnv).auth).toMatchObject({
      mode: 'sso',
      issuers: ['admin-console', 'other'],
    });
  });
});

describe('jwt', () => {
  it('round-trips and rejects tampering', () => {
    const t = signHs256({ a: 1 }, SSO);
    expect(verifyHs256(t, SSO)).toEqual({ a: 1 });
    expect(() => verifyHs256(t, SESSION)).toThrow(/bad signature/);
    const [h, p] = t.split('.');
    expect(() => verifyHs256(`${h}.${p}.x`, SSO)).toThrow(/bad signature/);
  });

  it.each([
    [123, /malformed/],
    ['a.b', /malformed/],
    ['x'.repeat(5000), /malformed/],
    ['!!.!!.!!', /malformed/],
  ])('rejects malformed %#', (t, re) => expect(() => verifyHs256(t, SSO)).toThrow(re));

  it('rejects alg none / other algorithms and non-object payloads', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(() => verifyHs256(`${enc({ alg: 'none' })}.${enc({})}.`, SSO)).toThrow(/only HS256/);
    expect(() => verifyHs256(`${enc(null)}.${enc({})}.`, SSO)).toThrow(/only HS256/);
    const body = `${enc({ alg: 'HS256' })}.${enc([1])}`;
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', SSO).update(body).digest('base64url');
    expect(() => verifyHs256(`${body}.${sig}`, SSO)).toThrow(/malformed payload/);
  });
});

function clockAt(sec) {
  return { now: () => sec * 1000 };
}

describe('SSO handoff', () => {
  const NOW = 1_800_000_000;
  const claims = (o = {}) => ({
    iss: 'admin-console',
    aud: 'chaos',
    sub: 'u1',
    name: 'Ada',
    iat: NOW,
    exp: NOW + 60,
    ...o,
  });
  const auth = () => createAuth(loadConfig(ssoEnv), clockAt(NOW + 1));

  it('exchanges a valid 60 s token for a Chaos session signed with another secret', () => {
    const a = auth();
    const s = a.exchangeSso(signHs256(claims(), SSO));
    expect(s.user).toEqual({ sub: 'admin-console:u1', name: 'Ada' });
    expect(() => verifyHs256(s.token, SSO)).toThrow(/bad signature/);
    expect(a.verifySession(s.token)).toEqual({ sub: 'admin-console:u1', name: 'Ada' });
    expect(a.exchangeSso(signHs256(claims({ aud: ['x', 'chaos'], sub: 'u2' }), SSO)).user.sub).toBe(
      'admin-console:u2',
    );
  });

  it.each([
    [claims({ iss: 'evil' }), /unknown issuer/],
    [claims({ aud: 'other' }), /audience/],
    [claims({ sub: '' }), /sub/],
    [claims({ name: 3 }), /name/],
    [claims({ iat: 'x' }), /iat and exp/],
    [claims({ exp: NOW + 61 }), /60 s/],
    [claims({ iat: NOW + 10, exp: NOW + 20 }), /future/],
    [claims({ iat: NOW - 60, exp: NOW }), /expired/],
  ])('rejects bad claims %#', (c, re) => {
    expect(() => auth().exchangeSso(signHs256(c, SSO))).toThrow(re);
  });

  it('rejects a token signed with the session secret, and replays', () => {
    const a = auth();
    expect(() => a.exchangeSso(signHs256(claims(), SESSION))).toThrow(/bad signature/);
    const t = signHs256(claims(), SSO);
    a.exchangeSso(t);
    expect(() => a.exchangeSso(t)).toThrow(/already used/);
  });

  it('forgets used tokens after they expire', () => {
    let now = NOW + 1;
    const a = createAuth(loadConfig(ssoEnv), { now: () => now * 1000 });
    a.exchangeSso(signHs256(claims(), SSO));
    now = NOW + 100;
    a.exchangeSso(signHs256(claims({ iat: NOW + 99, exp: NOW + 120 }), SSO));
  });

  it('an SSO token is never accepted as a session', () => {
    expect(() => auth().verifySession(signHs256(claims(), SESSION))).toThrow(/not a Chaos session/);
    expect(() =>
      auth().verifySession(
        signHs256(claims({ iss: 'chaos', aud: 'chaos-session', exp: 'x' }), SESSION),
      ),
    ).toThrow(/expired/);
  });

  it('local login is disabled in SSO mode', () => {
    expect(() => auth().loginLocal('a', 'b')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('local account', () => {
  const a = () => createAuth(loadConfig(localEnv));
  it('logs in with the .env account only', () => {
    expect(a().loginLocal('admin', 'correct horse battery').user).toEqual({
      sub: 'local:admin',
      name: 'admin',
    });
    expect(() => a().loginLocal('admin', 'wrong')).toThrow(/invalid credentials/);
    expect(() => a().loginLocal('root', 'correct horse battery')).toThrow(/invalid credentials/);
    expect(() => a().exchangeSso('x')).toThrow(expect.objectContaining({ code: 'SSO_DISABLED' }));
  });

  it('middleware requires a valid bearer session', () => {
    const auth = a();
    const { token } = auth.loginLocal('admin', 'correct horse battery');
    const call = (header) => {
      const req = { get: () => header };
      let err;
      auth.middleware(req, null, (e) => (err = e));
      return { req, err };
    };
    expect(call(`Bearer ${token}`).req.user.name).toBe('admin');
    expect(call(undefined).err.status).toBe(401);
    expect(call('Bearer nope').err.message).toMatch(/malformed/);
  });
});
