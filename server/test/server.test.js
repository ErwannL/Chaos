import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { startServer, cliContext } from '../src/server.js';
import { renderReportHtml } from '../src/report-html.js';
import { createContext } from '../src/context.js';
import { demoTargetDoc } from './helpers/fixtures.js';
import { makeRunnerEnv, DB_OUTAGE } from './helpers/sim.js';

function envFor(dir) {
  const targetsFile = join(dir, 'chaos.targets.yaml');
  writeFileSync(targetsFile, stringify({ targets: [demoTargetDoc()] }));
  return {
    CHAOS_PORT: '0',
    CHAOS_LOCAL_USER: 'admin',
    CHAOS_LOCAL_PASSWORD: 'correct horse battery',
    CHAOS_DATA_DIR: join(dir, 'data'),
    CHAOS_TARGETS_FILE: targetsFile,
    CHAOS_SCENARIOS_DIR: join(dir, 'scenarios'),
    DOCKER_SOCKET: join(dir, 'no.sock'),
  };
}

describe('server bootstrap', () => {
  it('recovers pending injections, listens on loopback and shuts down on signals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-'));
    const env = envFor(dir);
    const handlers = {};
    const logs = [];
    let exitCode;
    const ctx0 = cliContext(env);
    ctx0.journal.begin({
      target: 'demo',
      project: 'chaos-demo',
      service: 'mysql',
      fault: 'latency',
    });
    const tpCalls = [];
    const fetchImpl = async (url, o) => {
      tpCalls.push([o?.method, url]);
      return { ok: true, status: 204, json: async () => ({}) };
    };
    const { server, config, shutdown } = await startServer({
      env,
      onSignal: (s, fn) => (handlers[s] = fn),
      exit: (c) => (exitCode = c),
      log: (m) => logs.push(m),
      overrides: { fetchImpl },
    });
    expect(config.host).toBe('127.0.0.1');
    expect(server.address().address).toBe('127.0.0.1');
    expect(tpCalls).toEqual([
      ['DELETE', 'http://127.0.0.1:8474/proxies/mysql/toxics/chaos_latency'],
    ]);
    expect(logs[0]).toMatch(/recovery: latency on demo\/mysql: reverted/);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/mode`);
    expect(await res.json()).toEqual({ mode: 'local' });
    await handlers.SIGTERM();
    await handlers.SIGINT();
    await shutdown('again');
    expect(exitCode).toBe(0);
    expect(logs.filter((l) => /aborting/.test(l))).toHaveLength(1);
  });

  it('uses process defaults (env, signals, console)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-'));
    const env = envFor(dir);
    const saved = { ...process.env };
    Object.assign(process.env, env);
    const before = process.listeners('SIGTERM').length;
    let code;
    try {
      const { shutdown } = await startServer({ exit: (c) => (code = c) });
      expect(process.listeners('SIGTERM').length).toBe(before + 1);
      await shutdown('test');
    } finally {
      for (const s of ['SIGINT', 'SIGTERM']) {
        const ls = process.listeners(s);
        process.removeListener(s, ls.at(-1));
      }
      process.env = saved;
    }
    expect(code).toBe(0);
  });

  it('context wires real drivers per target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-'));
    const env = envFor(dir);
    const ctx = createContext({
      dataDir: env.CHAOS_DATA_DIR,
      targetsFile: env.CHAOS_TARGETS_FILE,
      scenariosDir: env.CHAOS_SCENARIOS_DIR,
      dockerSocket: env.DOCKER_SOCKET,
    });
    const [t] = ctx.targets();
    const d = ctx.drivers(t);
    expect(d.docker.project).toBe('chaos-demo');
    expect(d.toxiproxy).toHaveProperty('addToxic');
    expect(ctx.drivers({ ...t, toxiproxy: undefined }).toxiproxy).toBeNull();
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const cc = cliContext({});
      expect(cc.scenarios.list()).toEqual([]);
      expect(cc.log('quiet')).toBeUndefined();
    } finally {
      process.chdir(prev);
    }
  });
});

describe('HTML report', () => {
  it('escapes content and renders verdicts, steps, timeline and errors', async () => {
    const env = makeRunnerEnv();
    const report = await env.runner.wait(
      env.runner.start({ scenario: DB_OUTAGE, target: 'demo' }).id,
    );
    report.errors = ['<script>alert(1)</script>'];
    report.steps[0].error = 'boom';
    report.steps[0].revertOk = false;
    report.windows.push({ ...report.windows[0], end: null });
    report.samples.push({
      ts: report.startedAtMs + 1,
      probe: 'health',
      status: null,
      error: 'timeout',
    });
    const html = renderReportHtml(report, 'xx');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('passé');
    expect(html).toContain('revert: KO — boom');
    expect(html).toContain('<svg');
    report.score = null;
    report.actor = undefined;
    report.errors = [];
    const en = renderReportHtml(report, 'en');
    expect(en).toContain('Resilience score: <span class="score">—</span>');
    expect(en).not.toContain('<h2>Errors');
  });
});
