import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRunnerEnv, DB_OUTAGE, CACHE_OUTAGE, simFetch } from './helpers/sim.js';
import { parseScenario } from '../src/scenarios.js';
import { parseTargets } from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';

const verdicts = (r) => r.expectations.map((e) => e.verdict);

describe('runner: end-to-end with fake Docker/Toxiproxy', () => {
  it('runs a DB outage: injects, observes, reverts, and passes', async () => {
    const env = makeRunnerEnv();
    const { id } = env.runner.start({ scenario: DB_OUTAGE, target: 'demo' }, 'alice');
    const report = await env.runner.wait(id);
    expect(verdicts(report)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(report.status).toBe('passed');
    expect(report.score).toBe(100);
    expect(report.steps[0]).toMatchObject({
      fault: 'connection_reset',
      revertOk: true,
      error: null,
    });
    expect(env.world.toxiproxy.proxy('mysql').enabled).toBe(true);
    expect(env.journal.pending()).toEqual([]);
    expect(env.journal.entries()[0]).toMatchObject({
      actor: 'alice',
      fault: 'connection_reset',
      revertOk: true,
    });
    expect(env.store.get(id).status).toBe('passed');
    expect(report.samples.some((s) => s.probe === 'route:/api/items')).toBe(true);
    expect(env.runner.active()).toBeNull();
  });

  it('FAILS when the demo cache bug is on (a test that must be able to fail)', async () => {
    const good = makeRunnerEnv();
    const ok = await good.runner.wait(
      good.runner.start({ scenario: CACHE_OUTAGE, target: 'demo' }).id,
    );
    expect(ok.status).toBe('passed');

    const buggy = makeRunnerEnv({ cacheBug: true });
    const bad = await buggy.runner.wait(
      buggy.runner.start({ scenario: CACHE_OUTAGE, target: 'demo' }).id,
    );
    expect(bad.status).toBe('failed');
    expect(bad.expectations[0]).toMatchObject({ type: 'no_5xx', verdict: 'failed' });
    expect(bad.expectations[0].evidence.every((s) => s.status === 500)).toBe(true);
    expect(bad.score).toBe(67);
    expect(buggy.world.toxiproxy.proxy('redis').enabled).toBe(true);
  });

  it('refuses a second concurrent run with 409', async () => {
    const env = makeRunnerEnv();
    const { id } = env.runner.start({ scenario: DB_OUTAGE, target: 'demo' });
    expect(() => env.runner.start({ scenario: DB_OUTAGE, target: 'demo' })).toThrow(
      expect.objectContaining({ status: 409, code: 'RUN_IN_PROGRESS' }),
    );
    expect(env.runner.active()).toEqual({ id, status: 'running' });
    await env.runner.wait(id);
  });

  it('refuses when another process holds the run lock (CLI vs server)', () => {
    const env = makeRunnerEnv();
    writeFileSync(join(env.dir, 'run.lock'), JSON.stringify({ pid: process.pid, runId: 'cli' }));
    expect(() => env.runner.start({ scenario: DB_OUTAGE, target: 'demo' })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('abort reverts the active fault and marks the run aborted', async () => {
    let n = 0;
    let env;
    env = makeRunnerEnv({
      fetchImpl: (url) => {
        if (url.endsWith('/health') && ++n === 6) env.runner.abort('run-1');
        return simFetch(env.world)(url);
      },
    });
    const { id } = env.runner.start({ scenario: DB_OUTAGE, target: 'demo' });
    const report = await env.runner.wait(id);
    expect(report.status).toBe('aborted');
    expect(env.world.toxiproxy.proxy('mysql').enabled).toBe(true);
    expect(report.steps[0].revertOk).toBe(true);
    expect(env.journal.pending()).toEqual([]);
    expect(() => env.runner.abort(id)).toThrow(/not running/);
    expect(() => env.runner.abort('nope')).toThrow(/not running/);
  });

  it('abortAll cancels everything and is a no-op when idle', async () => {
    let env;
    let fired = false;
    env = makeRunnerEnv({
      fetchImpl: (url) => {
        if (!fired && env.world.toxiproxy.proxy('mysql').enabled === false) {
          fired = true;
          env.runner.abortAll();
        }
        return simFetch(env.world)(url);
      },
    });
    const { id } = env.runner.start({ scenario: DB_OUTAGE, target: 'demo' });
    expect((await env.runner.wait(id)).status).toBe('aborted');
    expect(env.world.toxiproxy.proxy('mysql').enabled).toBe(true);
    expect(await env.runner.abortAll()).toBeNull();
  });

  it('reverts even when injection throws, and reports an error', async () => {
    const env = makeRunnerEnv();
    env.world.toxiproxy.setEnabled = async (name, enabled) => {
      env.world.toxiproxy.proxy(name).enabled = enabled;
      if (!enabled) throw new Error('toxiproxy exploded');
    };
    const report = await env.runner.wait(
      env.runner.start({ scenario: DB_OUTAGE, target: 'demo' }).id,
    );
    expect(report.status).toBe('error');
    expect(report.errors[0]).toMatch(/toxiproxy exploded/);
    expect(report.steps[0].revertOk).toBe(true);
    expect(env.world.toxiproxy.proxy('mysql').enabled).toBe(true);
  });

  it('keeps a failed revert pending in the journal after retries', async () => {
    const logs = [];
    const env = makeRunnerEnv({ log: (m) => logs.push(m) });
    env.world.toxiproxy.removeToxic = async () => {
      throw new Error('api down');
    };
    const report = await env.runner.wait(
      env.runner.start({ scenario: DB_OUTAGE, target: 'demo' }).id,
    );
    expect(report.status).toBe('error');
    expect(report.steps[0]).toMatchObject({ revertOk: false, error: 'revert failed: api down' });
    expect(logs).toHaveLength(3);
    expect(env.journal.pending()).toHaveLength(1);
  });

  it('records steps with pauses and multiple faults, and stops on an inject error', async () => {
    const env = makeRunnerEnv();
    const scenario = parseScenario({
      name: 'multi',
      baselineS: 0,
      recoveryS: 1,
      steps: [
        { fault: 'latency', service: 'redis', durationS: 1, params: { latencyMs: 10 } },
        { pause: 1 },
        { fault: 'service_pause', service: 'api', durationS: 2 },
      ],
      expectations: [
        { type: 'status_during', probe: 'liveness', status: 200, step: 2, settleS: 0 },
      ],
    });
    const report = await env.runner.wait(env.runner.start({ scenario, target: 'demo' }).id);
    expect(report.windows.map((w) => w.fault)).toEqual(['latency', 'service_pause']);
    expect(report.expectations[0].verdict).toBe('failed'); // paused API does not answer
    expect(report.samples.some((s) => s.probe === 'container:api')).toBe(true);
    expect(env.world.dockerApi.state.containers.get('c-api').paused).toBe(false);

    const env2 = makeRunnerEnv();
    env2.world.dockerApi.state.containers.delete('c-api');
    const r2 = await env2.runner.wait(env2.runner.start({ scenario, target: 'demo' }).id);
    expect(r2.status).toBe('error');
    expect(r2.steps).toHaveLength(2);
  });

  it('stops at the next step boundary when aborted during a pause', async () => {
    let env;
    const scenario = parseScenario({
      name: 'p',
      baselineS: 0,
      steps: [{ pause: 3 }, { fault: 'latency', service: 'mysql', durationS: 1 }],
    });
    let n = 0;
    env = makeRunnerEnv({
      maxLiveEvents: 3,
      fetchImpl: (url) => {
        if (++n === 2) env.runner.abortAll();
        return simFetch(env.world)(url);
      },
    });
    const { id } = env.runner.start({ scenario, target: 'demo' });
    const report = await env.runner.wait(id);
    expect(report.status).toBe('aborted');
    expect(report.steps).toEqual([]);
    expect(env.world.toxiproxy.calls).toEqual([]);
    expect(env.runner.get(id).events.length).toBeLessThanOrEqual(6);
  });

  it('reverts cleanly when a browser session cannot open', async () => {
    const env = makeRunnerEnv();
    env.world.browser.open = async () => {
      throw new Error('no chromium');
    };
    const scenario = parseScenario({
      name: 'b',
      baselineS: 0,
      steps: [{ fault: 'browser_offline', service: 'web', durationS: 1 }],
    });
    const report = await env.runner.wait(env.runner.start({ scenario, target: 'demo' }).id);
    expect(report).toMatchObject({
      status: 'error',
      errors: ['step 0 (browser_offline): no chromium'],
    });
    expect(report.steps[0].revertOk).toBe(true);
  });

  it('reports errors thrown outside steps (e.g. by a live listener)', async () => {
    const env = makeRunnerEnv();
    const { id } = env.runner.start({ scenario: CACHE_OUTAGE, target: 'demo' });
    let thrown = false;
    env.runner.subscribe(id, () => {
      if (!thrown) {
        thrown = true;
        throw new Error('listener broke');
      }
    });
    const report = await env.runner.wait(id);
    expect(report.status).toBe('error');
    expect(report.errors).toEqual(['listener broke']);
  });

  it('observes the frontend during browser faults', async () => {
    const env = makeRunnerEnv({
      world: { snapshot: { blank: false, errorShown: true, errorText: 'API indisponible' } },
    });
    const scenario = parseScenario({
      name: 'browser',
      baselineS: 0,
      recoveryS: 0,
      steps: [{ fault: 'browser_offline', service: 'web', durationS: 4 }],
      expectations: [{ type: 'frontend_error_shown' }, { type: 'frontend_not_blank' }],
    });
    const report = await env.runner.wait(env.runner.start({ scenario, target: 'demo' }).id);
    expect(verdicts(report)).toEqual(['passed', 'passed']);
    expect(env.world.browser.sessions[0].closed).toBe(true);
  });

  it('detects a service kill and its restart', async () => {
    const env = makeRunnerEnv();
    const c = env.world.dockerApi.state.containers.get('c-api');
    c.autoRestart = true;
    c.startedAt = 't0';
    const scenario = parseScenario({
      name: 'kill',
      baselineS: 1,
      recoveryS: 2,
      steps: [{ fault: 'service_kill', service: 'api', durationS: 3 }],
      expectations: [{ type: 'service_restarts', service: 'api', seconds: 10, bySelf: true }],
    });
    const report = await env.runner.wait(env.runner.start({ scenario, target: 'demo' }).id);
    expect(report.expectations[0].verdict).toBe('passed');
  });

  it('turns an unexpected internal error into an error report', async () => {
    const env = makeRunnerEnv();
    env.world.toxiproxy.addToxic = undefined;
    const scenario = parseScenario({
      name: 'x',
      baselineS: 0,
      steps: [{ fault: 'latency', service: 'mysql', durationS: 1 }],
    });
    const report = await env.runner.wait(env.runner.start({ scenario, target: 'demo' }).id);
    expect(report.status).toBe('error');
    expect(report.score).toBeNull();
  });

  it('get() and subscribe() serve live runs and stored reports', async () => {
    const env = makeRunnerEnv();
    const seen = [];
    const { id } = env.runner.start({ scenario: CACHE_OUTAGE, target: 'demo' });
    const off = env.runner.subscribe(id, (e) => seen.push(e.type));
    await env.runner.wait(id);
    off();
    expect(seen).toContain('inject');
    expect(seen.at(-1)).toBe('finished');
    expect(env.runner.get(id).report.status).toBe('passed');
    // A fresh runner (after restart) reads the stored report
    const env2 = makeRunnerEnv();
    env2.store.save({ ...env.store.get(id) });
    expect(env2.runner.get(id)).toMatchObject({ done: true, status: 'passed' });
    const off2 = env2.runner.subscribe(id, () => {});
    off2();
    expect(() => env2.runner.get('missing')).toThrow(/Unknown run/);
  });
});

describe('runner: plan (validation without execution)', () => {
  it('returns the target verdict and an estimate', () => {
    const env = makeRunnerEnv();
    const p = env.runner.plan({ scenario: DB_OUTAGE, target: 'demo' });
    expect(p).toMatchObject({ ok: true, estimatedDurationS: 22, errors: [], warnings: [] });
    expect(p.target).toMatchObject({ name: 'demo', allowed: true, environment: 'local' });
    expect(env.world.toxiproxy.calls).toEqual([]); // nothing executed
  });

  it('reports every invalid step', () => {
    const env = makeRunnerEnv();
    const scenario = parseScenario({
      name: 'bad',
      steps: [
        { fault: 'nope', service: 'mysql', durationS: 1 },
        { fault: 'latency', service: 'ghost', durationS: 1 },
        { fault: 'latency', service: 'web', durationS: 1 },
        { fault: 'latency', service: 'mysql', durationS: 1, params: { latencyMs: -5 } },
        { fault: 'latency', service: 'mysql', durationS: 601 },
      ],
      expectations: [
        { type: 'service_restarts', service: 'ghost', seconds: 1 },
        { type: 'frontend_not_blank' },
      ],
    });
    const p = env.runner.plan({ scenario, target: 'demo' });
    expect(p.ok).toBe(false);
    expect(p.errors.map((e) => e.code)).toEqual([
      'FAULT_UNKNOWN',
      'SERVICE_UNKNOWN',
      'FAULT_INCOMPATIBLE',
      'PARAM_INVALID',
      'DURATION_TOO_LONG',
      'SERVICE_UNKNOWN',
    ]);
    expect(p.warnings).toEqual(['frontend_not_blank needs a browser_* step: unmeasurable']);
    expect(() => env.runner.start({ scenario, target: 'demo' })).toThrow(
      expect.objectContaining({ status: 403, code: 'GUARD_REFUSED' }),
    );
    const onlyBadParams = parseScenario({
      name: 'p',
      steps: [{ fault: 'latency', service: 'mysql', durationS: 1, params: { x: 1 } }],
    });
    expect(() => env.runner.start({ scenario: onlyBadParams, target: 'demo' })).toThrow(
      expect.objectContaining({ status: 400, code: 'PLAN_INVALID' }),
    );
  });

  it('warns about probes that are not configured', () => {
    const [t] = parseTargets({ targets: [demoTargetDoc({ probes: {} })] }, {});
    const env = makeRunnerEnv({ targets: [t] });
    const p = env.runner.plan({ scenario: DB_OUTAGE, target: 'demo' });
    expect(p.warnings).toEqual([
      'Probe health is not configured: unmeasurable',
      'Probe liveness is not configured: unmeasurable',
      'Probe health is not configured: unmeasurable',
      'Probe status is not configured: unmeasurable',
    ]);
  });

  it('refuses production targets whatever the flags', () => {
    const [prod] = parseTargets({ targets: [demoTargetDoc({ environment: 'production' })] }, {});
    const env = makeRunnerEnv({ targets: [prod] });
    const opts = {
      scenario: DB_OUTAGE,
      target: 'demo',
      allowRemote: true,
      confirmHost: '127.0.0.1',
    };
    expect(env.runner.plan(opts).target.reasons[0].code).toBe('ENV_PRODUCTION');
    expect(() => env.runner.start(opts)).toThrow(expect.objectContaining({ status: 403 }));
    expect(env.world.toxiproxy.calls).toEqual([]);
  });

  it('refuses remote hosts unless confirmed server side', async () => {
    const [remote] = parseTargets(
      { targets: [demoTargetDoc({ baseUrl: 'http://recette.local:8081' })] },
      {},
    );
    const env = makeRunnerEnv({ targets: [remote] });
    expect(() =>
      env.runner.start({ scenario: CACHE_OUTAGE, target: 'demo', allowRemote: true }),
    ).toThrow(expect.objectContaining({ code: 'GUARD_REFUSED' }));
    const { id } = env.runner.start({
      scenario: CACHE_OUTAGE,
      target: 'demo',
      allowRemote: true,
      confirmHost: 'recette.local',
    });
    await env.runner.wait(id);
  });
});
