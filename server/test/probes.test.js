import { describe, it, expect } from 'vitest';
import { createProber, _test } from '../src/probes.js';
import { makeWorld } from './helpers/ctx.js';
import { parseTargets } from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';

function res(status, body) {
  return {
    status,
    json: async () => (body instanceof Error ? Promise.reject(body) : body),
    text: async () => String(body),
    arrayBuffer: async () => Promise.reject(new Error('x')),
  };
}

describe('probes', () => {
  it('extracts components from maps, arrays and nested paths', () => {
    const c = _test.componentsFrom;
    expect(
      c(
        { components: { db: 'UP', cache: { status: 'down' }, q: { state: 'degraded' } } },
        'components',
      ),
    ).toEqual({
      db: 'up',
      cache: 'down',
      q: 'degraded',
    });
    expect(
      c({ a: { list: [{ name: 'db', status: 'ok' }, { status: 'x' }, null] } }, 'a.list'),
    ).toEqual({ db: 'ok' });
    expect(c(null, 'components')).toEqual({});
    expect(c('weird', '')).toEqual({});
  });

  it('samples all configured probes, routes and containers', async () => {
    const world = makeWorld();
    const [target] = parseTargets(
      {
        targets: [
          demoTargetDoc({
            probes: {
              health: 'http://127.0.0.1/health',
              liveness: 'http://127.0.0.1/livez',
              status: { url: 'http://127.0.0.1/status', componentsPath: 'c' },
              metrics: { url: 'http://127.0.0.1/metrics', token: 'tok' },
              logs: { url: 'http://127.0.0.1:3100/', selector: '{app="api"}' },
            },
          }),
        ],
      },
      {},
    );
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push([url, opts.headers]);
      if (url.includes('/health')) throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      if (url.includes('/livez')) throw new Error('ECONNREFUSED');
      if (url.includes('/status')) return res(200, { c: { db: 'up' } });
      if (url.includes('/metrics')) return res(200, '# HELP\na 1\nb 2\n');
      if (url.includes('/loki')) return res(200, { data: { result: [{ value: [0, '4'] }] } });
      return res(204, null);
    };
    const prober = createProber({ target, fetchImpl, clock: world.clock, docker: world.docker });
    const out = await prober.sample({ routes: ['/api/items'], services: ['api', 'ghost'] });
    const by = Object.fromEntries(out.map((x) => [x.probe, x]));
    expect(by.health).toMatchObject({ status: null, error: 'timeout' });
    expect(by.liveness).toMatchObject({ status: null, error: 'ECONNREFUSED' });
    expect(by.status.data).toEqual({ components: { db: 'up' } });
    expect(by.metrics.data).toEqual({ series: 2 });
    expect(by.logs.data).toEqual({ errors: 4 });
    expect(by['route:/api/items'].status).toBe(204);
    expect(by['container:api']).toMatchObject({ running: true, paused: false });
    expect(by['container:ghost']).toMatchObject({
      running: false,
      error: expect.stringMatching(/No container/),
    });
    expect(seen.find(([u]) => u.includes('metrics'))[1]).toEqual({ authorization: 'Bearer tok' });
    expect(decodeURIComponent(seen.find(([u]) => u.includes('loki'))[0])).toContain(
      'sum(count_over_time({app="api"} |~ "(?i)error" [1s]))',
    );
    expect(prober.routeUrl('/x')).toBe('http://127.0.0.1:8081/x');
  });

  it('handles bad JSON, empty loki results, no token and no optional probes', async () => {
    const world = makeWorld();
    const [target] = parseTargets(
      {
        targets: [
          demoTargetDoc({
            probes: {
              status: 'http://127.0.0.1/status',
              metrics: 'http://127.0.0.1/metrics',
              logs: { url: 'http://127.0.0.1:3100', selector: '{a="b"}', errorFilter: '|= "E"' },
            },
          }),
        ],
      },
      {},
    );
    const fetchImpl = async (url, opts) => {
      if (url.includes('metrics')) expect(opts.headers).toEqual({});
      return res(200, url.includes('metrics') ? '' : new Error('bad json'));
    };
    const out = await createProber({
      target,
      fetchImpl,
      clock: world.clock,
      docker: world.docker,
    }).sample();
    expect(out.map((x) => x.probe)).toEqual(['status', 'metrics', 'logs']);
    expect(out[0].data).toEqual({ components: {} });
    expect(out[2].data).toEqual({ errors: 0 });
    const none = parseTargets({ targets: [demoTargetDoc({ probes: {} })] }, {})[0];
    expect(await createProber({ target: none, fetchImpl, clock: world.clock }).sample()).toEqual(
      [],
    );
  });

  it('stringifies non-Error failures', async () => {
    const world = makeWorld();
    const out = await createProber({
      target: world.target,
      fetchImpl: async () => {
        throw 'weird';
      },
      clock: world.clock,
    }).sample({ include: ['health'] });
    expect(out[0].error).toBe('weird');
  });
});
