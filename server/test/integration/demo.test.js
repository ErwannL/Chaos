// Integration test: plays real scenarios against the real demo stack
// (docker compose). Run with `npm run test:integration` (needs Docker).
// CHAOS_IT_NO_BUILD=1 reuses already-built images.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const COMPOSE = ['compose', '-f', join(ROOT, 'demo-target/docker-compose.yml')];
const DATA = mkdtempSync(join(tmpdir(), 'chaos-it-'));
const build = process.env.CHAOS_IT_NO_BUILD === '1' ? '--no-build' : '--build';

function sh(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function compose(args, env) {
  const r = sh('docker', [...COMPOSE, ...args], env);
  if (r.code !== 0) throw new Error(r.out);
  return r;
}

function chaos(...args) {
  return sh('node', ['server/bin/chaos.js', ...args], {
    CHAOS_DATA_DIR: DATA,
    DEMO_METRICS_TOKEN: 'demo-metrics-token',
  });
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8080/health')).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('demo target never became healthy');
}

describe.skipIf(process.env.CHAOS_IT !== '1')('integration: Chaos vs demo target', () => {
  beforeAll(async () => {
    compose(['up', '-d', build, '--wait'], { DEMO_BUG: '0' });
    await waitHealthy();
  });

  afterAll(() => {
    if (process.env.CHAOS_IT_KEEP !== '1') compose(['down', '-v']);
  });

  it('db-outage passes: health 503 during, liveness 200, recovery', () => {
    const r = chaos('run', 'db-outage', '--target', 'demo');
    expect(r.out).toMatch(/passed, score 100/);
    expect(r.code).toBe(0);
  });

  it('cache-outage passes when the cache falls back to the DB', () => {
    const r = chaos('run', 'cache-outage', '--target', 'demo');
    expect(r.code, r.out).toBe(0);
  });

  it('cache-outage FAILS (exit 1) when the demo bug is enabled', async () => {
    compose(['up', '-d', '--no-build', '--wait', 'api'], { DEMO_BUG: '1' });
    await waitHealthy();
    try {
      const r = chaos('run', 'cache-outage', '--target', 'demo');
      expect(r.out).toMatch(/FAILED\s+no_5xx/);
      expect(r.code).toBe(1);
    } finally {
      compose(['up', '-d', '--no-build', '--wait', 'api'], { DEMO_BUG: '0' });
      await waitHealthy();
    }
  });

  it('the API comes back by itself after a process crash', () => {
    const r = chaos('run', 'api-crash', '--target', 'demo');
    expect(r.code, r.out).toBe(0);
  });

  it('the frontend shows an error, not a blank page, when a chunk is missing', () => {
    const r = chaos('run', 'frontend-missing-chunk', '--target', 'demo');
    expect(r.code, r.out).toBe(0);
  });

  it('refuses a production target (exit 2, nothing injected)', () => {
    const r = sh('node', ['server/bin/chaos.js', 'plan', 'db-outage', '--target', 'demo'], {
      CHAOS_DATA_DIR: DATA,
      CHAOS_TARGETS_FILE: join(ROOT, 'server/test/integration/prod.targets.yaml'),
    });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/ENV_PRODUCTION/);
  });

  it('leaves nothing pending in the injection journal', () => {
    expect(chaos('recover').out).toBe('');
  });
});
