import { describe, it, expect } from 'vitest';
import {
  assertEnvironmentAllowed,
  assertHostsAllowed,
  assertDuration,
  assertTargetAllowed,
  isLoopbackHost,
  remoteHosts,
  targetVerdict,
} from '../src/guards.js';
import { parseTargets } from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';

const make = (o) => parseTargets({ targets: [demoTargetDoc(o)] }, {})[0];
const remoteTarget = () =>
  make({
    baseUrl: 'http://recette.example.com:8081',
    probes: { health: 'http://Recette.example.com/health' },
  });

function code(fn) {
  try {
    fn();
  } catch (e) {
    expect(e.status).toBe(403);
    return e.code;
  }
  return 'NO_ERROR';
}

describe('guard: production environment', () => {
  it.each(['production', 'prod', 'PROD', ' Production ', 'prod-eu'])('refuses %j', (env) => {
    expect(code(() => assertEnvironmentAllowed(env))).toBe('ENV_PRODUCTION');
  });

  it('refuses production even with every remote flag set', () => {
    const t = make({ environment: 'production' });
    expect(code(() => assertTargetAllowed(t, { allowRemote: true, confirmHost: '*' }))).toBe(
      'ENV_PRODUCTION',
    );
    expect(targetVerdict(t, { allowRemote: true }).allowed).toBe(false);
  });

  it.each(['staging', '', undefined, null])('refuses unknown environment %j', (env) => {
    expect(code(() => assertEnvironmentAllowed(env))).toBe('ENV_UNKNOWN');
  });

  it.each(['local', 'recette', 'Recette'])('accepts %j', (env) => {
    expect(code(() => assertEnvironmentAllowed(env))).toBe('NO_ERROR');
  });
});

describe('guard: loopback hosts', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['10.0.0.1', 'example.com', '0.0.0.0', 'localhost.evil.com', '128.0.0.1'])(
    '%s is not loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false),
  );

  it('accepts an all-loopback target without flags', () => {
    expect(remoteHosts(make())).toEqual([]);
    expect(code(() => assertHostsAllowed(make()))).toBe('NO_ERROR');
  });

  it('refuses a remote host without --allow-remote', () => {
    expect(remoteHosts(remoteTarget())).toEqual(['recette.example.com']);
    expect(code(() => assertHostsAllowed(remoteTarget(), {}))).toBe('REMOTE_HOST');
    expect(code(() => assertHostsAllowed(remoteTarget()))).toBe('REMOTE_HOST');
    expect(code(() => assertHostsAllowed(remoteTarget(), { allowRemote: 'true' }))).toBe(
      'REMOTE_HOST',
    );
  });

  it('refuses --allow-remote without a matching --confirm-host', () => {
    const t = remoteTarget();
    expect(code(() => assertHostsAllowed(t, { allowRemote: true }))).toBe(
      'REMOTE_HOST_UNCONFIRMED',
    );
    expect(code(() => assertHostsAllowed(t, { allowRemote: true, confirmHost: 'recette' }))).toBe(
      'REMOTE_HOST_UNCONFIRMED',
    );
  });

  it('accepts --allow-remote with the host typed again', () => {
    const t = remoteTarget();
    expect(
      code(() => assertHostsAllowed(t, { allowRemote: true, confirmHost: 'RECETTE.example.com' })),
    ).toBe('NO_ERROR');
    expect(
      code(() =>
        assertHostsAllowed(t, { allowRemote: true, confirmHost: ['recette.example.com'] }),
      ),
    ).toBe('NO_ERROR');
    expect(targetVerdict(t, { allowRemote: true, confirmHost: 'recette.example.com' })).toEqual({
      allowed: true,
      reasons: [],
      remoteHosts: ['recette.example.com'],
    });
  });

  it('requires every remote host to be confirmed', () => {
    const t = make({
      baseUrl: 'http://a.example',
      frontendUrl: 'http://[2001:db8::1]:8080',
      probes: {},
    });
    expect(remoteHosts(t)).toEqual(['2001:db8::1', 'a.example']);
    expect(code(() => assertHostsAllowed(t, { allowRemote: true, confirmHost: 'a.example' }))).toBe(
      'REMOTE_HOST_UNCONFIRMED',
    );
    expect(
      code(() =>
        assertHostsAllowed(t, { allowRemote: true, confirmHost: 'a.example,[2001:db8::1]' }),
      ),
    ).toBe('NO_ERROR');
  });
});

describe('guard: duration', () => {
  const fault = { key: 'latency', maxDurationS: 60 };
  it('refuses durations above the fault maximum', () => {
    expect(code(() => assertDuration(fault, 61))).toBe('DURATION_TOO_LONG');
  });
  it.each([0, -1, NaN, Infinity])('refuses invalid duration %s', (d) => {
    expect(code(() => assertDuration(fault, d))).toBe('DURATION_INVALID');
  });
  it('accepts a bounded duration', () => {
    expect(code(() => assertDuration(fault, 60))).toBe('NO_ERROR');
  });
});
