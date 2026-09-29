import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../src/journal.js';
import { acquireRunLock } from '../src/lock.js';
import { createStore } from '../src/store.js';
import { createScenarioRepo, parseScenario, EXPECTATION_FIELDS } from '../src/scenarios.js';
import { recoverPending } from '../src/recovery.js';
import { systemClock } from '../src/clock.js';
import { createCatalog } from '../src/catalog/index.js';
import { makeWorld } from './helpers/ctx.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'chaos-p-'));

describe('journal', () => {
  it('tracks who, what, when and whether revert succeeded', () => {
    const file = join(tmp(), 'sub', 'journal.jsonl');
    const j = createJournal({ file });
    const id = j.begin({
      actor: 'bob',
      runId: 'r',
      target: 't',
      project: 'p',
      service: 's',
      fault: 'latency',
      params: {},
    });
    j.checkpoint(id, { a: 1 });
    expect(j.pending()[0]).toMatchObject({ id, state: { a: 1 }, injected: false, revertOk: null });
    j.injected(id, { a: 2 });
    j.reverted(id, false, { error: 'nope' });
    expect(j.pending()[0]).toMatchObject({
      state: { a: 2 },
      revertOk: false,
      error: 'nope',
      revertedBy: 'runner',
    });
    j.reverted(id, true, { by: 'recovery' });
    expect(j.pending()).toEqual([]);
    expect(j.entries()[0]).toMatchObject({
      actor: 'bob',
      revertOk: true,
      revertedBy: 'recovery',
      error: null,
    });
    j.reverted(id, true);
  });

  it('survives a torn last line and orphan events, and starts empty', () => {
    const file = join(tmp(), 'j.jsonl');
    const j = createJournal({ file });
    expect(j.entries()).toEqual([]);
    const id = j.begin({ fault: 'x' });
    appendFileSync(file, '{"event":"revert","id":"other","ok":true}\n{"event":"rev');
    expect(j.pending().map((e) => e.id)).toEqual([id]);
    expect(readFileSync(file, 'utf8')).toContain('inject_start');
  });
});

describe('run lock', () => {
  it('is exclusive while the holder is alive and released after', () => {
    const file = join(tmp(), 'run.lock');
    const release = acquireRunLock(file, 'a');
    expect(() => acquireRunLock(file, 'b')).toThrow(expect.objectContaining({ status: 409 }));
    release();
    release();
    acquireRunLock(file, 'c')();
  });

  it('takes over a stale or unreadable lock', () => {
    const file = join(tmp(), 'run.lock');
    writeFileSync(file, JSON.stringify({ pid: 999_999_999, runId: 'dead' }));
    acquireRunLock(file, 'x')();
    writeFileSync(file, 'garbage');
    acquireRunLock(file, 'y')();
    writeFileSync(file, JSON.stringify({ pid: 1, runId: 'eperm' }));
    expect(() => acquireRunLock(file, 'z', { isAlive: () => true })).toThrow(/in progress/);
  });

  it('gives up when a stale lock cannot be removed', () => {
    const file = join(tmp(), 'run.lock');
    writeFileSync(file, JSON.stringify({ pid: 5, runId: 'x' }));
    expect(() => acquireRunLock(file, 'y', { isAlive: () => false, unlink: () => {} })).toThrow(
      /Could not acquire/,
    );
  });

  it('rethrows unexpected open errors', () => {
    expect(() => acquireRunLock(join(tmp(), 'x'.repeat(300)), 'x')).toThrow(/ENAMETOOLONG|ENOENT/);
  });

  it('rethrows unexpected filesystem errors', () => {
    const f = join(tmp(), 'file');
    writeFileSync(f, '');
    expect(() => acquireRunLock(join(f, 'run.lock'), 'x')).toThrow(/ENOTDIR|EEXIST/);
  });

  it('checks real liveness with signal 0', () => {
    const file = join(tmp(), 'run.lock');
    writeFileSync(file, JSON.stringify({ pid: process.pid, runId: 'init' }));
    // A live pid (this very process) → considered alive
    expect(() => acquireRunLock(file, 'x')).toThrow(/in progress/);
  });
});

describe('store', () => {
  it('saves, gets and lists reports newest first', () => {
    const store = createStore({ dir: join(tmp(), 'runs') });
    const rep = (id, startedAt) => ({
      id,
      scenario: { name: 's' },
      target: 't',
      status: 'passed',
      score: 100,
      startedAt,
    });
    store.save(rep('a', '2026-01-01'));
    store.save(rep('b', '2026-02-01'));
    expect(store.list().map((r) => r.id)).toEqual(['b', 'a']);
    expect(store.get('a').startedAt).toBe('2026-01-01');
    expect(() => store.get('zz')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => store.get('../etc/passwd')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('scenarios', () => {
  it('lists, gets and saves scenarios, flagging invalid files', () => {
    const dir = tmp();
    const repo = createScenarioRepo({ dir });
    repo.save({ name: 'ok', steps: [{ pause: 1 }] });
    writeFileSync(join(dir, 'broken.yml'), 'name: broken\nsteps: []\n');
    expect(
      repo
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['broken', 'ok']);
    expect(repo.get('ok')).toMatchObject({
      baselineS: 3,
      recoveryS: 10,
      watch: [],
      expectations: [],
    });
    expect(() => repo.get('broken')).toThrow(/Invalid scenario/);
    expect(() => repo.get('nope')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => repo.save({ name: '../x', steps: [{ pause: 1 }] })).toThrow(/name/);
  });

  it('every expectation type has a field spec matching the schema', () => {
    for (const [type, fields] of Object.entries(EXPECTATION_FIELDS)) {
      const doc = { type };
      for (const [k, f] of Object.entries(fields)) {
        if (f.required)
          doc[k] = f.type === 'enum' ? f.values[0] : (f.default ?? (f.type === 'string' ? 'x' : 1));
      }
      expect(() =>
        parseScenario({ name: 'a', steps: [{ pause: 1 }], expectations: [doc] }),
      ).not.toThrow();
    }
  });

  it('validates steps and expectation types', () => {
    expect(() => parseScenario({ name: 'a', steps: [{ fault: 'x' }] })).toThrow(/Invalid/);
    expect(() =>
      parseScenario({ name: 'a', steps: [{ pause: 1 }], expectations: [{ type: 'magic' }] }),
    ).toThrow(/Invalid/);
    expect(() =>
      parseScenario({
        name: 'a',
        steps: [{ pause: 1 }],
        expectations: [{ type: 'no_5xx', route: 'http://evil' }],
      }),
    ).toThrow(/route/);
  });
});

describe('startup recovery', () => {
  function setup() {
    const world = makeWorld();
    const journal = createJournal({ file: join(tmp(), 'j.jsonl') });
    const logs = [];
    const deps = {
      journal,
      catalog: createCatalog(),
      targets: () => [world.target],
      drivers: () => ({ docker: world.docker, toxiproxy: world.toxiproxy, browser: world.browser }),
      clock: world.clock,
    };
    return { world, journal, logs, deps };
  }

  it('reverts injections left pending by a crash', async () => {
    const { world, journal, deps } = setup();
    world.toxiproxy.proxy('mysql').enabled = false;
    world.dockerApi.state.containers.get('c-api').paused = true;
    const a = journal.begin({
      target: 'demo',
      project: 'chaos-demo',
      service: 'mysql',
      fault: 'connection_reset',
    });
    journal.checkpoint(a, { proxy: 'mysql', mode: 'disable' });
    const b = journal.begin({ target: 'demo', service: 'api', fault: 'service_pause' });
    const c = journal.begin({ target: 'demo', service: 'web', fault: 'browser_offline' });
    const done = journal.begin({ target: 'demo', service: 'api', fault: 'service_pause' });
    journal.reverted(done, true);
    const res = await recoverPending(deps);
    expect(res.map((r) => [r.id, r.ok])).toEqual([
      [a, true],
      [b, true],
      [c, true],
    ]);
    expect(world.toxiproxy.proxy('mysql').enabled).toBe(true);
    expect(world.dockerApi.state.containers.get('c-api').paused).toBe(false);
    expect(journal.pending()).toEqual([]);
  });

  it('keeps failures pending and logs them', async () => {
    const { journal, deps, logs } = setup();
    journal.begin({ target: 'gone', service: 'x', fault: 'latency' });
    journal.begin({ target: 'demo', project: 'renamed', service: 'mysql', fault: 'latency' });
    const res = await recoverPending({ ...deps, log: (m) => logs.push(m) });
    expect(res.map((r) => r.ok)).toEqual([false, false]);
    expect(res[1].error).toMatch(/project changed/);
    expect(journal.pending()).toHaveLength(2);
    expect(logs[0]).toMatch(/Unknown target gone/);
    expect(
      await recoverPending({ ...deps, journal: createJournal({ file: join(tmp(), 'e') }) }),
    ).toEqual([]);
  });
});

describe('system clock', () => {
  it('sleeps and can be aborted', async () => {
    const t0 = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(t0 + 4);
    const c = new AbortController();
    const p = systemClock.sleep(10_000, c.signal);
    c.abort();
    await p;
    await systemClock.sleep(10_000, c.signal);
  });
});
