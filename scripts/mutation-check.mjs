// Proves the tests CAN fail: each mutation breaks a safety property on
// purpose, runs the relevant tests, and expects them to go red. The file
// is always restored.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MUTATIONS = [
  {
    what: 'production environments are no longer refused',
    file: 'server/src/guards.js',
    from: "FORBIDDEN_ENVIRONMENTS.includes(env) || env.startsWith('prod')",
    to: 'false',
    test: ['server', 'test/guards.test.js'],
  },
  {
    what: '--confirm-host is no longer compared server side',
    file: 'server/src/guards.js',
    from: 'const missing = remote.filter((h) => !confirmed.has(h));',
    to: 'const missing = [];',
    test: ['server', 'test/guards.test.js'],
  },
  {
    what: 'containers of other compose projects become reachable',
    file: 'server/src/drivers/docker.js',
    from: 'if (info.Config?.Labels?.[PROJECT_LABEL] !== this.project) {',
    to: 'if (false) {',
    test: ['server', 'test/docker.test.js'],
  },
  {
    what: 'the runner forgets to revert a fault',
    file: 'server/src/runner.js',
    from: '          await revertInjection(run, inj);\n',
    to: '\n',
    test: ['server', 'test/runner.test.js'],
  },
  {
    what: 'a 5xx is no longer detected during a fault',
    file: 'server/src/expectations.js',
    from: 'const bad = s.filter((x) => x.status >= 500);',
    to: 'const bad = [];',
    test: ['server', 'test/runner.test.js'],
  },
  {
    what: 'SSO tokens valid for more than 60 s are accepted',
    file: 'server/src/auth.js',
    from: "if (c.exp - c.iat > SSO_MAX_LIFETIME_S) reject('token lifetime exceeds 60 s');",
    to: '',
    test: ['server', 'test/auth.test.js'],
  },
  {
    what: 'the demo cache always falls back (bug switch ignored)',
    file: 'demo-target/api/src/app.js',
    from: 'if (bugCacheNoFallback) {',
    to: 'if (false) {',
    test: ['demo-target/api', 'test/app.test.js'],
  },
];

let failures = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.error(`✗ mutation target not found in ${m.file}: ${m.from}`);
    failures++;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  try {
    const [cwd, file] = m.test;
    const r = spawnSync('npx', ['vitest', 'run', file], { cwd, encoding: 'utf8' });
    if (r.status === 0) {
      console.error(`✗ tests still pass although ${m.what}`);
      failures++;
    } else {
      console.log(`✓ tests fail when ${m.what}`);
    }
  } finally {
    writeFileSync(m.file, original);
  }
}
process.exit(failures ? 1 : 0);
