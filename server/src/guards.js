import { isIP } from 'node:net';
import { GuardError } from './errors.js';

export const ALLOWED_ENVIRONMENTS = ['local', 'recette'];
const FORBIDDEN_ENVIRONMENTS = ['production', 'prod'];

/** Refuses production-like environments. No option can bypass this. */
export function assertEnvironmentAllowed(environment) {
  const env = String(environment ?? '')
    .trim()
    .toLowerCase();
  if (FORBIDDEN_ENVIRONMENTS.includes(env) || env.startsWith('prod')) {
    throw new GuardError('ENV_PRODUCTION', `Environment "${environment}" is production: refused`);
  }
  if (!ALLOWED_ENVIRONMENTS.includes(env)) {
    throw new GuardError('ENV_UNKNOWN', `Environment "${environment}" is not local or recette`);
  }
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isLoopbackHost(rawHost) {
  const host = stripBrackets(String(rawHost).toLowerCase());
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = host.startsWith('::ffff:') ? host.slice(7) : host;
  return isIP(v4) === 4 && v4.startsWith('127.');
}

/** Every URL a target makes Chaos talk to. */
export function targetUrls(target) {
  const p = target.probes;
  return [
    target.baseUrl,
    target.frontendUrl,
    target.toxiproxy?.url,
    p.health,
    p.liveness,
    p.status?.url,
    p.metrics?.url,
    p.logs?.url,
  ].filter(Boolean);
}

export function remoteHosts(target) {
  const hosts = new Set();
  for (const u of targetUrls(target)) {
    const host = stripBrackets(new URL(u).hostname.toLowerCase());
    if (!isLoopbackHost(host)) hosts.add(host);
  }
  return [...hosts].sort();
}

function parseConfirm(confirmHost) {
  const list = Array.isArray(confirmHost) ? confirmHost : String(confirmHost ?? '').split(',');
  return new Set(list.map((h) => stripBrackets(String(h).trim().toLowerCase())).filter(Boolean));
}

/**
 * Refuses non-loopback hosts unless allowRemote === true AND every remote host
 * has been typed again in confirmHost. The comparison happens here, server side.
 */
export function assertHostsAllowed(target, { allowRemote, confirmHost } = {}) {
  const remote = remoteHosts(target);
  if (remote.length === 0) return;
  if (allowRemote !== true) {
    throw new GuardError(
      'REMOTE_HOST',
      `Non-loopback host(s) ${remote.join(', ')} need --allow-remote`,
      {
        remoteHosts: remote,
      },
    );
  }
  const confirmed = parseConfirm(confirmHost);
  const missing = remote.filter((h) => !confirmed.has(h));
  if (missing.length) {
    throw new GuardError(
      'REMOTE_HOST_UNCONFIRMED',
      `--confirm-host must repeat exactly: ${missing.join(', ')}`,
      { remoteHosts: remote },
    );
  }
}

export function assertDuration(fault, durationS) {
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new GuardError('DURATION_INVALID', `Duration must be > 0 for ${fault.key}`);
  }
  if (durationS > fault.maxDurationS) {
    throw new GuardError(
      'DURATION_TOO_LONG',
      `${fault.key} lasts at most ${fault.maxDurationS}s (asked ${durationS}s)`,
    );
  }
}

/** Evaluates all target-level guards and returns a verdict instead of throwing. */
export function targetVerdict(target, opts = {}) {
  const reasons = [];
  for (const check of [
    () => assertEnvironmentAllowed(target.environment),
    () => assertHostsAllowed(target, opts),
  ]) {
    try {
      check();
    } catch (e) {
      reasons.push({ code: e.code, message: e.message });
    }
  }
  return { allowed: reasons.length === 0, reasons, remoteHosts: remoteHosts(target) };
}

export function assertTargetAllowed(target, opts = {}) {
  assertEnvironmentAllowed(target.environment);
  assertHostsAllowed(target, opts);
}
