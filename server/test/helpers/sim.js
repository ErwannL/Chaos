// A simulated demo target driven by the fake Toxiproxy/Docker state, so the
// runner can be tested end to end without containers.
import { makeWorld } from './ctx.js';
import { createCatalog } from '../../src/catalog/index.js';
import { createJournal } from '../../src/journal.js';
import { createStore } from '../../src/store.js';
import { createRunner } from '../../src/runner.js';
import { parseScenario } from '../../src/scenarios.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function simFetch(world, { cacheBug = false, onRequest } = {}) {
  const mysqlUp = () =>
    world.toxiproxy.proxy('mysql').enabled &&
    !world.dockerApi.state.containers.get('c-mysql').paused;
  const redisUp = () => world.toxiproxy.proxy('redis').enabled;
  const apiUp = () => {
    const c = world.dockerApi.state.containers.get('c-api');
    return c.running && !c.paused;
  };
  return async (url) => {
    onRequest?.(url);
    const path = new URL(url).pathname;
    const reply = (status, body = {}) => ({
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    if (!apiUp()) throw new Error('ECONNREFUSED');
    if (path === '/livez') return reply(200);
    if (path === '/health') return reply(mysqlUp() ? 200 : 503);
    if (path === '/api/status') {
      return reply(200, {
        components: {
          db: { status: mysqlUp() ? 'up' : 'down' },
          cache: redisUp() ? 'up' : 'degraded',
        },
      });
    }
    if (path === '/metrics') return reply(200, '# HELP x\nhttp_requests_total 3\n');
    if (path === '/api/items') {
      if (!mysqlUp()) return reply(503);
      if (!redisUp() && cacheBug) return reply(500);
      return reply(200, []);
    }
    return reply(404);
  };
}

export function makeRunnerEnv(opts = {}) {
  const world = makeWorld(opts.world);
  const dir = mkdtempSync(join(tmpdir(), 'chaos-run-'));
  const journal = createJournal({ file: join(dir, 'journal.jsonl'), clock: world.clock });
  const store = createStore({ dir: join(dir, 'runs') });
  const catalog = createCatalog();
  let n = 0;
  const targetsList = opts.targets ?? [world.target];
  const runner = createRunner({
    catalog,
    targets: () => targetsList,
    journal,
    store,
    drivers: () => ({ docker: world.docker, toxiproxy: world.toxiproxy, browser: world.browser }),
    clock: world.clock,
    lockFile: join(dir, 'run.lock'),
    fetchImpl: opts.fetchImpl ?? simFetch(world, opts),
    idGen: () => `run-${++n}`,
    log: opts.log,
    maxLiveEvents: opts.maxLiveEvents,
  });
  return { world, dir, journal, store, catalog, runner };
}

export const DB_OUTAGE = parseScenario({
  name: 'db-outage',
  baselineS: 2,
  recoveryS: 10,
  watch: ['/api/items'],
  steps: [{ fault: 'connection_reset', service: 'mysql', durationS: 10 }],
  expectations: [
    { type: 'status_during', probe: 'health', status: 503 },
    { type: 'status_during', probe: 'liveness', status: 200 },
    { type: 'recovers_within', probe: 'health', status: 200, seconds: 5 },
    { type: 'status_component', component: 'db', state: 'down' },
  ],
});

export const CACHE_OUTAGE = parseScenario({
  name: 'cache-outage',
  baselineS: 1,
  recoveryS: 3,
  steps: [{ fault: 'connection_reset', service: 'redis', durationS: 5 }],
  expectations: [
    { type: 'no_5xx', route: '/api/items' },
    { type: 'status_component', component: 'cache', state: ['degraded', 'down'] },
    { type: 'status_during', probe: 'health', status: 200 },
  ],
});
