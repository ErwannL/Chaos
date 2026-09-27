import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { parseScenario } from './scenarios.js';
import { recoverPending } from './recovery.js';

export const EXIT = { OK: 0, FAILED: 1, ERROR: 2, USAGE: 64 };

const USAGE = `Usage:
  chaos run <scenario|file.yaml> --target <name> [--allow-remote --confirm-host=<host>] [--strict] [--json]
  chaos plan <scenario|file.yaml> --target <name> [--allow-remote --confirm-host=<host>]
  chaos catalog
  chaos recover

Exit code: 0 all expectations passed, 1 an expectation failed, 2 refused/error/aborted.
--strict also fails on unmeasurable expectations.`;

function loadScenario(ctx, ref) {
  if (/\.ya?ml$/.test(ref) && existsSync(resolve(ref))) {
    return parseScenario(parse(readFileSync(resolve(ref), 'utf8')));
  }
  return ctx.scenarios.get(ref);
}

/**
 * CLI entry. The CLI runs the same runner in-process: guards are enforced
 * by the runner, and the run lock is shared with the server (409).
 */
export async function main(
  argv,
  { ctx, out = console.log, err = console.error, onSignal = process.on.bind(process) },
) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        target: { type: 'string', short: 't' },
        'allow-remote': { type: 'boolean', default: false },
        'confirm-host': { type: 'string' },
        strict: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    err(e.message);
    err(USAGE);
    return EXIT.USAGE;
  }
  const [cmd, ref] = args.positionals;
  const o = args.values;
  if (o.help || !cmd) {
    out(USAGE);
    return o.help ? EXIT.OK : EXIT.USAGE;
  }
  try {
    if (cmd === 'catalog') {
      for (const f of ctx.catalog.describe())
        out(`${f.key.padEnd(24)} ${f.title.en} [${f.roles.join(',')}] max ${f.maxDurationS}s`);
      return EXIT.OK;
    }
    if (cmd === 'recover') {
      const res = await recoverPending({ ...ctx, log: out });
      return res.every((r) => r.ok) ? EXIT.OK : EXIT.ERROR;
    }
    if ((cmd !== 'run' && cmd !== 'plan') || !ref || !o.target) {
      err(USAGE);
      return EXIT.USAGE;
    }
    const input = {
      scenario: loadScenario(ctx, ref),
      target: o.target,
      allowRemote: o['allow-remote'],
      confirmHost: o['confirm-host'],
    };
    if (cmd === 'plan') {
      const p = ctx.runner.plan(input);
      out(JSON.stringify(p, null, 2));
      return p.ok ? EXIT.OK : EXIT.ERROR;
    }
    const { id } = ctx.runner.start(input, process.env.USER ? `cli:${process.env.USER}` : 'cli');
    const stop = () => {
      err('Interrupted: reverting active faults...');
      ctx.runner.abortAll();
    };
    onSignal('SIGINT', stop);
    onSignal('SIGTERM', stop);
    if (!o.json) {
      ctx.runner.subscribe(id, (e) => {
        if (e.type === 'inject')
          out(`→ inject ${e.fault} on ${e.service} ${JSON.stringify(e.params)}`);
        if (e.type === 'revert') out(`← revert ${e.fault}: ${e.ok ? 'OK' : `FAILED ${e.error}`}`);
        if (e.type === 'phase') out(`· ${e.phase}`);
        if (e.type === 'error') out(`! ${e.message}`);
      });
    }
    const report = await ctx.runner.wait(id);
    if (o.json) {
      out(JSON.stringify({ ...report, samples: undefined }, null, 2));
    } else {
      for (const x of report.expectations)
        out(`${x.verdict.toUpperCase().padEnd(13)} ${x.type}: ${x.message}`);
      out(`Run ${report.id}: ${report.status}, score ${report.score ?? '—'}`);
    }
    if (report.status === 'failed') return EXIT.FAILED;
    if (report.status !== 'passed') return EXIT.ERROR;
    if (o.strict && report.expectations.some((x) => x.verdict === 'unmeasurable'))
      return EXIT.FAILED;
    return EXIT.OK;
  } catch (e) {
    err(`${e.code ?? 'ERROR'}: ${e.message}`);
    return EXIT.ERROR;
  }
}
