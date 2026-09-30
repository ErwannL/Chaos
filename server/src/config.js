import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ChaosError } from './errors.js';
import { isLoopbackHost } from './guards.js';
import { dockerEndpoint } from './drivers/docker.js';

const MIN_SECRET = 32;

/** Reads and validates the server configuration from the environment. */
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const fail = (m) => {
    throw new ChaosError('CONFIG_INVALID', m, 500);
  };
  const host = env.CHAOS_HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host)) fail(`CHAOS_HOST must be a loopback address (got ${host})`);
  const ssoSecret = env.CHAOS_SSO_SECRET || null;
  let sessionSecret = env.CHAOS_SESSION_SECRET || null;
  let auth;
  if (ssoSecret) {
    if (ssoSecret.length < MIN_SECRET) fail(`CHAOS_SSO_SECRET must be >= ${MIN_SECRET} characters`);
    if (!sessionSecret) fail('CHAOS_SESSION_SECRET is required when SSO is enabled');
    const issuers = (env.CHAOS_SSO_ISSUERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!issuers.length) fail('CHAOS_SSO_ISSUERS is required when SSO is enabled');
    auth = { mode: 'sso', ssoSecret, issuers };
  } else {
    if (!env.CHAOS_LOCAL_USER || !env.CHAOS_LOCAL_PASSWORD) {
      fail('Set CHAOS_LOCAL_USER and CHAOS_LOCAL_PASSWORD (or configure SSO)');
    }
    if (env.CHAOS_LOCAL_PASSWORD.length < 12) fail('CHAOS_LOCAL_PASSWORD must be >= 12 characters');
    auth = { mode: 'local', user: env.CHAOS_LOCAL_USER, password: env.CHAOS_LOCAL_PASSWORD };
    sessionSecret ??= randomBytes(48).toString('hex'); // sessions do not survive a restart
  }
  if (sessionSecret.length < MIN_SECRET)
    fail(`CHAOS_SESSION_SECRET must be >= ${MIN_SECRET} characters`);
  if (sessionSecret === ssoSecret) fail('CHAOS_SESSION_SECRET must differ from CHAOS_SSO_SECRET');
  const orqeaUrl = env.CHAOS_ORQEA_URL ?? 'https://orqea.dev';
  if (!/^https?:\/\//.test(orqeaUrl)) fail('CHAOS_ORQEA_URL must be an http(s) URL');
  const port = Number(env.CHAOS_PORT ?? 8090);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('CHAOS_PORT is invalid');
  const dataDir = resolve(cwd, env.CHAOS_DATA_DIR ?? 'data');
  return {
    host,
    port,
    dataDir,
    targetsFile: resolve(cwd, env.CHAOS_TARGETS_FILE ?? 'chaos.targets.yaml'),
    scenariosDir: resolve(cwd, env.CHAOS_SCENARIOS_DIR ?? 'scenarios'),
    webDir: env.CHAOS_WEB_DIR ? resolve(cwd, env.CHAOS_WEB_DIR) : null,
    dockerSocket: dockerEndpoint(env),
    orqeaUrl,
    frameAncestors: env.CHAOS_FRAME_ANCESTORS ?? "'self'",
    sessionTtlS: Number(env.CHAOS_SESSION_TTL_S ?? 8 * 3600),
    auth: { ...auth, sessionSecret },
  };
}
