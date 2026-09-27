import { createHash, timingSafeEqual } from 'node:crypto';
import { ChaosError } from './errors.js';
import { signHs256, verifyHs256 } from './jwt.js';

const SSO_MAX_LIFETIME_S = 60;
const CLOCK_SKEW_S = 5;
const SESSION_ISS = 'chaos';
const SESSION_AUD = 'chaos-session';

const unauthorized = (m) => new ChaosError('UNAUTHORIZED', m, 401);
const sha = (s) => createHash('sha256').update(String(s)).digest();

/**
 * SSO handoff: a 60 s HS256 JWT signed with CHAOS_SSO_SECRET is exchanged
 * for a Chaos session token signed with a DIFFERENT secret. Without SSO, a
 * single local account from the environment.
 */
export function createAuth(config, clock = { now: Date.now }) {
  const { auth, sessionTtlS } = config;
  const used = new Map(); // SSO token hash -> exp (replay protection)
  const nowS = () => Math.floor(clock.now() / 1000);

  function issueSession(user) {
    const iat = nowS();
    const exp = iat + sessionTtlS;
    const token = signHs256(
      { iss: SESSION_ISS, aud: SESSION_AUD, sub: user.sub, name: user.name, iat, exp },
      auth.sessionSecret,
    );
    return { token, user, expiresAt: new Date(exp * 1000).toISOString() };
  }

  function exchangeSso(token) {
    if (auth.mode !== 'sso') throw new ChaosError('SSO_DISABLED', 'SSO is not configured', 404);
    const c = verifyHs256(token, auth.ssoSecret);
    const now = nowS();
    const reject = (m) => {
      throw new ChaosError('SSO_REJECTED', m, 401);
    };
    if (!auth.issuers.includes(c.iss)) reject('unknown issuer');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes('chaos')) reject('audience must be chaos');
    if (typeof c.sub !== 'string' || !c.sub) reject('sub is required');
    if (typeof c.name !== 'string' || !c.name) reject('name is required');
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) reject('iat and exp are required');
    if (c.exp - c.iat > SSO_MAX_LIFETIME_S) reject('token lifetime exceeds 60 s');
    if (c.iat > now + CLOCK_SKEW_S) reject('token issued in the future');
    if (c.exp <= now) reject('token expired');
    for (const [k, exp] of used) if (exp <= now) used.delete(k);
    const key = sha(token).toString('hex');
    if (used.has(key)) reject('token already used');
    used.set(key, c.exp);
    return issueSession({ sub: `${c.iss}:${c.sub}`, name: c.name });
  }

  function loginLocal(username, password) {
    if (auth.mode !== 'local') throw new ChaosError('LOCAL_DISABLED', 'Use SSO', 404);
    const okUser = timingSafeEqual(sha(username), sha(auth.user));
    const okPass = timingSafeEqual(sha(password), sha(auth.password));
    if (!(okUser && okPass)) throw unauthorized('invalid credentials');
    return issueSession({ sub: `local:${auth.user}`, name: auth.user });
  }

  function verifySession(token) {
    const c = verifyHs256(token, auth.sessionSecret);
    if (c.iss !== SESSION_ISS || c.aud !== SESSION_AUD) throw unauthorized('not a Chaos session');
    if (!Number.isInteger(c.exp) || c.exp <= nowS()) throw unauthorized('session expired');
    return { sub: c.sub, name: c.name };
  }

  function middleware(req, _res, next) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!m) return next(unauthorized('missing bearer token'));
    try {
      req.user = verifySession(m[1]);
      next();
    } catch (e) {
      next(unauthorized(e.message));
    }
  }

  return { mode: auth.mode, exchangeSso, loginLocal, verifySession, middleware };
}
