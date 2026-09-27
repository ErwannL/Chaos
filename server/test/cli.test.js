import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { main, EXIT } from '../src/cli.js';
import { makeAppEnv } from './helpers/app-env.js';
import { simFetch } from './helpers/sim.js';
import { parseTargets } from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';

function cli(opts = {}) {
  const env = makeAppEnv(opts);
  const out = [];
  const err = [];
  const handlers = {};
  const run = (argv) =>
    main(argv, {
      ctx: env.ctx,
      out: (m) => out.push(m),
      err: (m) => err.push(m),
      onSignal: (sig, fn) => (handlers[sig] = fn),
    });
  return { env, out, err, run, handlers };
}

describe('CLI', () => {
  it('exits 0 when every expectation passes', async () => {
    const c = cli();
    expect(await c.run(['run', 'db-outage', '--target', 'demo'])).toBe(EXIT.OK);
    expect(c.out.join('\n')).toMatch(/→ inject connection_reset on mysql/);
    expect(c.out.join('\n')).toMatch(/← revert connection_reset: OK/);
    expect(c.out.at(-1)).toMatch(/passed, score 100/);
  });

  it('exits 1 when an expectation fails (usable in CI)', async () => {
    const c = cli({ cacheBug: true });
    expect(await c.run(['run', 'cache-outage', '-t', 'demo'])).toBe(EXIT.FAILED);
    expect(c.out.join('\n')).toMatch(/FAILED\s+no_5xx/);
  });

  it('runs a scenario file and prints JSON', async () => {
    const c = cli();
    const file = join(c.env.dir, 'my.yaml');
    writeFileSync(
      file,
      stringify({
        name: 'file-scn',
        baselineS: 0,
        recoveryS: 0,
        steps: [{ fault: 'latency', service: 'redis', durationS: 1 }],
      }),
    );
    const user = process.env.USER;
    process.env.USER = 'ci-bot';
    expect(await c.run(['run', file, '--target', 'demo', '--json'])).toBe(EXIT.OK);
    delete process.env.USER;
    expect(await c.run(['run', file, '--target', 'demo'])).toBe(EXIT.OK);
    expect(c.out.at(-1)).toMatch(/passed, score —/);
    if (user !== undefined) process.env.USER = user;
    expect(c.env.journal.entries().map((e) => e.actor)).toEqual(['cli', 'cli:ci-bot']);
    const report = JSON.parse(c.out.find((l) => l.startsWith('{')));
    expect(report.scenario.name).toBe('file-scn');
    expect(report.samples).toBeUndefined();
  });

  it('--strict fails on unmeasurable expectations', async () => {
    const c = cli();
    c.env.ctx.scenarios.save({
      name: 'um',
      baselineS: 0,
      recoveryS: 0,
      steps: [{ fault: 'latency', service: 'redis', durationS: 1 }],
      expectations: [{ type: 'frontend_not_blank' }],
    });
    expect(await c.run(['run', 'um', '--target', 'demo'])).toBe(EXIT.OK);
    expect(await c.run(['run', 'um', '--target', 'demo', '--strict'])).toBe(EXIT.FAILED);
  });

  it('exits 2 on refusal, error or abort', async () => {
    const c = cli();
    expect(await c.run(['run', 'nope', '--target', 'demo'])).toBe(EXIT.ERROR);
    expect(c.err.at(-1)).toMatch(/SCENARIO_UNKNOWN/);
    c.env.world.toxiproxy.setEnabled = async () => {
      throw new Error('tp down');
    };
    expect(await c.run(['run', 'db-outage', '--target', 'demo'])).toBe(EXIT.ERROR);
    expect(c.out.join('\n')).toMatch(/! tp down/);
    expect(c.out.join('\n')).toMatch(/revert connection_reset: FAILED tp down/);
  });

  it('SIGINT aborts and reverts', async () => {
    let c;
    let n = 0;
    c = cli({
      fetchImpl: (url) => {
        if (++n === 8) c.handlers.SIGINT();
        return simFetch(c.env.world)(url);
      },
    });
    expect(await c.run(['run', 'db-outage', '--target', 'demo'])).toBe(EXIT.ERROR);
    expect(c.err).toContain('Interrupted: reverting active faults...');
    expect(c.env.world.toxiproxy.proxy('mysql').enabled).toBe(true);
    expect(typeof c.handlers.SIGTERM).toBe('function');
  });

  it('plan, catalog, recover, help and usage errors', async () => {
    const c = cli();
    expect(await c.run(['plan', 'db-outage', '--target', 'demo'])).toBe(EXIT.OK);
    expect(JSON.parse(c.out.at(-1)).ok).toBe(true);
    c.env.ctx.scenarios.save({
      name: 'bad',
      steps: [{ fault: 'latency', service: 'web', durationS: 1 }],
    });
    expect(await c.run(['plan', 'bad', '--target', 'demo'])).toBe(EXIT.ERROR);
    expect(await c.run(['catalog'])).toBe(EXIT.OK);
    expect(c.out.at(-1)).toMatch(/^disk_pressure/);
    expect(await c.run(['recover'])).toBe(EXIT.OK);
    c.env.journal.begin({ target: 'ghost', service: 'x', fault: 'latency' });
    expect(await c.run(['recover'])).toBe(EXIT.ERROR);
    c.env.ctx.runner = {
      plan: () => {
        throw new Error('plain');
      },
    };
    expect(await c.run(['plan', 'db-outage', '--target', 'demo'])).toBe(EXIT.ERROR);
    expect(c.err.at(-1)).toBe('ERROR: plain');
    expect(await c.run(['--help'])).toBe(EXIT.OK);
    expect(await c.run([])).toBe(EXIT.USAGE);
    expect(await c.run(['run', 'db-outage'])).toBe(EXIT.USAGE);
    expect(await c.run(['explode'])).toBe(EXIT.USAGE);
    expect(await c.run(['run', '--bogus'])).toBe(EXIT.USAGE);
  });

  it('refuses production and unconfirmed remote targets', async () => {
    const [prod] = parseTargets({ targets: [demoTargetDoc({ environment: 'prod' })] }, {});
    const c = cli({ targets: [prod] });
    const flags = ['--allow-remote', '--confirm-host=127.0.0.1'];
    expect(await c.run(['run', 'db-outage', '--target', 'demo', ...flags])).toBe(EXIT.ERROR);
    expect(c.err.at(-1)).toMatch(/GUARD_REFUSED: .*production/);
    const [remote] = parseTargets(
      { targets: [demoTargetDoc({ baseUrl: 'http://recette.example' })] },
      {},
    );
    const r = cli({ targets: [remote] });
    expect(await r.run(['run', 'db-outage', '--target', 'demo', '--allow-remote'])).toBe(
      EXIT.ERROR,
    );
    expect(r.err.at(-1)).toMatch(/confirm-host/);
    expect(r.env.world.toxiproxy.calls).toEqual([]);
  });
});
