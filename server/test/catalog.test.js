import { describe, it, expect } from 'vitest';
import { FAULTS, createCatalog } from '../src/catalog/index.js';
import { validateParams } from '../src/catalog/params.js';
import { parseDf } from '../src/catalog/faults/disk-pressure.js';
import { makeWorld, faultCtx } from './helpers/ctx.js';

const catalog = createCatalog();

describe('catalog structure', () => {
  it('contains every required fault with a unique immutable key', () => {
    expect(FAULTS.map((f) => f.key)).toEqual([
      'latency',
      'connection_reset',
      'bandwidth',
      'service_pause',
      'service_kill',
      'egress_block',
      'browser_offline',
      'browser_slow_api',
      'browser_missing_chunk',
      'disk_pressure',
    ]);
    expect(Object.isFrozen(FAULTS)).toBe(true);
  });

  it.each(FAULTS.map((f) => [f.key, f]))('%s is fully described', (_k, f) => {
    expect(f.title.fr && f.title.en && f.description.fr && f.description.en).toBeTruthy();
    expect(f.roles.length).toBeGreaterThan(0);
    expect(f.maxDurationS).toBeGreaterThan(0);
    expect(typeof f.inject).toBe('function');
    expect(typeof f.revert).toBe('function');
    for (const spec of Object.values(f.params)) {
      expect(() => validateParams({ key: f.key, params: { p: spec } }, {})).not.toThrow();
    }
  });

  it('describe() exposes no functions', () => {
    const d = catalog.describe();
    expect(d).toHaveLength(FAULTS.length);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('rejects duplicate keys and unknown faults', () => {
    expect(() => createCatalog([FAULTS[0], FAULTS[0]])).toThrow(/Duplicate/);
    expect(() => catalog.get('nope')).toThrow(/Unknown fault/);
    expect(catalog.get('latency').key).toBe('latency');
  });

  it('computes compatibility from roles and requirements', () => {
    const { target } = makeWorld();
    const svc = (n) => target.services.find((s) => s.name === n);
    expect(catalog.incompatibilities(catalog.get('latency'), target, svc('mysql'))).toEqual([]);
    expect(catalog.incompatibilities(catalog.get('latency'), target, svc('api'))).toEqual([
      'requires proxy',
    ]);
    expect(catalog.incompatibilities(catalog.get('latency'), target, svc('web'))).toEqual([
      'role frontend not supported',
      'requires proxy',
    ]);
    expect(catalog.incompatibilities(catalog.get('browser_offline'), target, svc('web'))).toEqual(
      [],
    );
    const noFront = makeWorld({ target: { frontendUrl: undefined } }).target;
    expect(catalog.incompatibilities(catalog.get('browser_offline'), noFront, svc('web'))).toEqual([
      'requires frontendUrl',
    ]);
    expect(catalog.incompatibilities(catalog.get('disk_pressure'), target, svc('mysql'))).toEqual([
      'requires diskPath',
    ]);
  });
});

describe('typed params', () => {
  const fault = catalog.get('latency');
  it('applies defaults', () => {
    expect(validateParams(fault)).toEqual({ latencyMs: 1000, jitterMs: 0 });
  });
  it.each([
    [{ latencyMs: 30_001 }, /between 0 and 30000/],
    [{ latencyMs: -1 }, /between/],
    [{ latencyMs: 1.5 }, /not an integer/],
    [{ latencyMs: '100' }, /not a number/],
    [{ latencyMs: NaN }, /not a number/],
    [{ bogus: 1 }, /unknown for latency/],
  ])('refuses %j', (p, re) => {
    expect(() => validateParams(fault, p)).toThrow(re);
  });
  it('refuses non-object params', () => {
    expect(() => validateParams(fault, null)).toThrow(/must be an object/);
    expect(() => validateParams(fault, [])).toThrow(/must be an object/);
  });
  it('validates enums, strings, numbers and regexes', () => {
    const f = {
      key: 'x',
      params: {
        e: { type: 'enum', values: ['a'], default: 'a' },
        s: { type: 'string', regex: true, default: 'a+' },
        t: { type: 'string', default: 'x' },
        n: { type: 'number', min: 0, max: 1, default: 0.5 },
      },
    };
    expect(validateParams(f, {})).toEqual({ e: 'a', s: 'a+', t: 'x', n: 0.5 });
    expect(() => validateParams(f, { e: 'b' })).toThrow(/one of/);
    expect(() => validateParams(f, { s: '(' })).toThrow(/regular expression/);
    expect(() => validateParams(f, { t: 'x'.repeat(201) })).toThrow(/too long/);
    expect(() => validateParams(f, { t: 3 })).toThrow(/not a string/);
    expect(() => validateParams({ key: 'y', params: { z: { type: 'blob' } } }, {})).toThrow(
      /unknown type/,
    );
  });
});

async function roundTrip(key, serviceName, params = {}, world = makeWorld()) {
  const fault = catalog.get(key);
  const ctx = faultCtx(world, serviceName);
  const state = await fault.inject(ctx, validateParams(fault, params));
  return { fault, ctx, state, world };
}

describe('toxiproxy faults', () => {
  it.each([
    ['latency', { latencyMs: 500, jitterMs: 50 }, { latency: 500, jitter: 50 }],
    ['bandwidth', { rateKBps: 5 }, { rate: 5 }],
  ])('%s adds then removes its toxic', async (key, params, attrs) => {
    const { fault, ctx, state, world } = await roundTrip(key, 'mysql', params);
    const toxic = world.toxiproxy.proxy('mysql').toxics.get(`chaos_${key}`);
    expect(toxic.attributes).toEqual(attrs);
    expect(ctx.checkpoints).toEqual([state]);
    await fault.revert(ctx, state);
    expect(world.toxiproxy.proxy('mysql').toxics.size).toBe(0);
    await fault.revert(ctx, null);
  });

  it('connection_reset disables the proxy and re-enables it', async () => {
    const { fault, ctx, state, world } = await roundTrip('connection_reset', 'redis');
    expect(world.toxiproxy.proxy('redis').enabled).toBe(false);
    await fault.revert(ctx, state);
    expect(world.toxiproxy.proxy('redis').enabled).toBe(true);
  });

  it('connection_reset reset_peer mode uses a toxic, revert works without state', async () => {
    const { fault, ctx, world } = await roundTrip('connection_reset', 'redis', {
      mode: 'reset_peer',
    });
    expect(world.toxiproxy.proxy('redis').toxics.has('chaos_connection_reset')).toBe(true);
    await fault.revert(ctx, null);
    expect(world.toxiproxy.proxy('redis').toxics.size).toBe(0);
  });
});

describe('container faults', () => {
  it('service_pause pauses and unpauses', async () => {
    const { fault, ctx, state, world } = await roundTrip('service_pause', 'api');
    expect(world.dockerApi.state.containers.get('c-api').paused).toBe(true);
    await fault.revert(ctx, state);
    expect(world.dockerApi.state.containers.get('c-api').paused).toBe(false);
    await fault.revert(ctx, null); // idempotent, resolves container itself
  });

  it('service_kill kills, then restarts and waits until healthy', async () => {
    const { fault, ctx, state, world } = await roundTrip('service_kill', 'api');
    const c = world.dockerApi.state.containers.get('c-api');
    expect(c.running).toBe(false);
    c.health = 'starting';
    world.clock.sleep = async () => {
      c.health = 'healthy';
    };
    await fault.revert(ctx, state);
    expect(c.running).toBe(true);
  });

  it('service_kill revert without state and with auto-restart', async () => {
    const world = makeWorld();
    world.dockerApi.state.containers.get('c-api').autoRestart = true;
    const { fault, ctx } = await roundTrip('service_kill', 'api', {}, world);
    await fault.revert(ctx, null);
    expect(world.dockerApi.state.calls.some((x) => x.path.includes('/start'))).toBe(false);
  });

  it('service_kill revert fails when the service never comes back', async () => {
    const { fault, ctx, state, world } = await roundTrip('service_kill', 'api', {
      restartTimeoutS: 5,
    });
    world.dockerApi.state.containers.get('c-api').health = 'unhealthy';
    await expect(fault.revert(ctx, state)).rejects.toMatchObject({ code: 'RESTART_FAILED' });
  });

  it('never touches containers of another project', async () => {
    const world = makeWorld();
    const fault = catalog.get('service_kill');
    const ctx = faultCtx(world, 'api');
    await expect(fault.revert(ctx, { id: 'c-foreign' })).rejects.toMatchObject({
      code: 'PROJECT_MISMATCH',
    });
    expect(world.dockerApi.state.containers.get('c-foreign').running).toBe(true);
  });

  it('egress_block keeps internal networks and restores the others', async () => {
    const { fault, ctx, state, world } = await roundTrip('egress_block', 'api');
    const c = world.dockerApi.state.containers.get('c-api');
    expect(Object.keys(c.networks)).toEqual(['chaos-demo_backend']);
    expect(state.disconnected).toEqual([{ name: 'chaos-demo_egress', aliases: ['api'] }]);
    expect(ctx.checkpoints[0]).toEqual(state);
    await fault.revert(ctx, state);
    expect(Object.keys(c.networks).sort()).toEqual(['chaos-demo_backend', 'chaos-demo_egress']);
    await fault.revert(ctx, state); // already restored: no-op
    await fault.revert(ctx, null);
  });

  it('egress_block isolates a service with no internal network', async () => {
    const { fault, ctx, state, world } = await roundTrip('egress_block', 'web');
    const c = world.dockerApi.state.containers.get('c-web');
    expect(state.isolated).toBe('chaos-demo_chaos_isolated');
    expect(Object.keys(c.networks)).toEqual(['chaos-demo_chaos_isolated']);
    await fault.revert(ctx, state);
    expect(Object.keys(c.networks)).toEqual(['chaos-demo_egress']);
    expect(world.dockerApi.state.networks.has('chaos-demo_chaos_isolated')).toBe(false);
    // Revert after a crash before the isolated network was attached
    await fault.revert(ctx, state);
  });

  it('disk_pressure fills up to the bounded threshold then cleans', async () => {
    const world = makeWorld();
    const cmds = [];
    world.dockerApi.state.execHandler = (cmd) => {
      cmds.push(cmd);
      return cmd[0] === 'df'
        ? {
            exitCode: 0,
            output:
              'Filesystem 1024-blocks Used Available Capacity Mounted\ntmpfs 102400 10240 92160 10% /tmp/chaos\n',
          }
        : { exitCode: 0, output: '' };
    };
    const { fault, ctx, state } = await roundTrip(
      'disk_pressure',
      'api',
      { targetPercent: 50, maxMb: 4096 },
      world,
    );
    expect(state.mb).toBe(40);
    expect(cmds[1]).toEqual([
      'dd',
      'if=/dev/zero',
      'of=/tmp/chaos/.chaos-disk-pressure',
      'bs=1048576',
      'count=40',
    ]);
    await fault.revert(ctx, state);
    expect(cmds[2]).toEqual(['rm', '-f', '/tmp/chaos/.chaos-disk-pressure']);
    await fault.revert(ctx, null);
    expect(cmds[3]).toEqual(['rm', '-f', '/tmp/chaos/.chaos-disk-pressure']);
  });

  it('disk_pressure caps at maxMb and skips when already above threshold', async () => {
    const world = makeWorld();
    let used = 10240;
    world.dockerApi.state.execHandler = (cmd) =>
      cmd[0] === 'df'
        ? { exitCode: 0, output: `x 102400 ${used} 0 0% /` }
        : { exitCode: 0, output: '' };
    expect((await roundTrip('disk_pressure', 'api', { maxMb: 3 }, world)).state.mb).toBe(3);
    used = 100000;
    expect((await roundTrip('disk_pressure', 'api', {}, world)).state.mb).toBe(0);
  });

  it('disk_pressure reports df, dd and rm failures', async () => {
    const world = makeWorld();
    world.dockerApi.state.execHandler = () => ({ exitCode: 1, output: 'nope' });
    await expect(roundTrip('disk_pressure', 'api', {}, world)).rejects.toMatchObject({
      code: 'DISK_UNKNOWN',
    });
    world.dockerApi.state.execHandler = (cmd) =>
      cmd[0] === 'df'
        ? { exitCode: 0, output: 'x 102400 0 0 0% /' }
        : { exitCode: 1, output: 'full' };
    await expect(roundTrip('disk_pressure', 'api', {}, world)).rejects.toMatchObject({
      code: 'DISK_FILL_FAILED',
    });
    const ctx = faultCtx(world, 'api');
    await expect(catalog.get('disk_pressure').revert(ctx, null)).rejects.toMatchObject({
      code: 'DISK_CLEAN_FAILED',
    });
  });

  it('parseDf rejects garbage', () => {
    expect(() => parseDf('garbage')).toThrow(/Cannot parse/);
    expect(parseDf('h\nfs 10 2 8 20% /')).toEqual({ totalKb: 10, usedKb: 2 });
  });
});

describe('browser faults', () => {
  it.each([
    ['browser_offline', {}, { offline: true }],
    ['browser_slow_api', { delayMs: 200 }, { delayPattern: '/api/', delayMs: 200 }],
    ['browser_missing_chunk', {}, { blockPattern: '/assets/(?!index-)[^/]+\\.js$' }],
  ])('%s opens a browser session and closes it on revert', async (key, params, opts) => {
    const { fault, ctx, state, world } = await roundTrip(key, 'web', params);
    expect(world.browser.sessions[0].opts).toEqual({ url: 'http://localhost:8080', ...opts });
    expect(ctx.session).toBe(world.browser.sessions[0]);
    await fault.revert(ctx, state);
    expect(world.browser.sessions[0].closed).toBe(true);
  });
});
