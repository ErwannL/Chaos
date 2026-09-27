import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  parseTargets,
  loadTargets,
  findTarget,
  findService,
  publicTarget,
} from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';

describe('targets', () => {
  it('parses and normalizes a valid config', () => {
    const [t] = parseTargets({ targets: [demoTargetDoc()] }, { TOKEN_VAR: 's3cret' });
    expect(t.probes.status).toEqual({
      url: 'http://127.0.0.1:8081/api/status',
      componentsPath: 'components',
    });
    expect(t.probes.metrics.token).toBe('s3cret');
    expect(t.probes.timeoutMs).toBe(2000);
    expect(publicTarget(t).probes.metrics).toEqual({
      url: 'http://127.0.0.1:8081/metrics',
      hasToken: true,
    });
  });

  it('keeps object-form probes and defaults', () => {
    const doc = demoTargetDoc({
      probes: {
        status: { url: 'http://127.0.0.1/s', componentsPath: 'checks' },
        metrics: 'http://127.0.0.1/m',
      },
    });
    const [t] = parseTargets({ targets: [doc] }, {});
    expect(t.probes.status.componentsPath).toBe('checks');
    expect(t.probes.metrics).toEqual({ url: 'http://127.0.0.1/m', token: undefined });
    expect(t.probes.intervalMs).toBe(1000);
    const [bare] = parseTargets({ targets: [demoTargetDoc({ probes: {} })] }, {});
    expect(bare.probes.status).toBeUndefined();
    expect(publicTarget(bare).probes.metrics).toBeUndefined();
  });

  it('rejects invalid documents', () => {
    expect(() => parseTargets({})).toThrow(/Invalid targets config/);
    expect(() =>
      parseTargets({ targets: [demoTargetDoc({ services: [{ name: 'x', role: 'bogus' }] })] }),
    ).toThrow(/role/);
    expect(() =>
      parseTargets({
        targets: [demoTargetDoc({ services: [{ name: 'x', role: 'api', diskPath: '/a/../b' }] })],
      }),
    ).toThrow(/diskPath/);
  });

  it('rejects duplicates and proxies without toxiproxy', () => {
    expect(() => parseTargets({ targets: [demoTargetDoc(), demoTargetDoc()] })).toThrow(
      /Duplicate target/,
    );
    const dupSvc = demoTargetDoc({
      services: [
        { name: 'a', role: 'api' },
        { name: 'a', role: 'db' },
      ],
    });
    expect(() => parseTargets({ targets: [dupSvc] })).toThrow(/Duplicate service/);
    const noTp = demoTargetDoc({ toxiproxy: undefined });
    expect(() => parseTargets({ targets: [noTp] })).toThrow(/no toxiproxy/);
  });

  it('loads from a file and reports missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-t-'));
    const file = join(dir, 'chaos.targets.yaml');
    writeFileSync(file, stringify({ targets: [demoTargetDoc()] }));
    expect(loadTargets(file)[0].name).toBe('demo');
    expect(() => loadTargets(join(dir, 'nope.yaml'))).toThrow(/Cannot read/);
  });

  it('finds targets and services', () => {
    const targets = parseTargets({ targets: [demoTargetDoc()] }, {});
    expect(findTarget(targets, 'demo').project).toBe('chaos-demo');
    expect(() => findTarget(targets, 'x')).toThrow(/Unknown target/);
    expect(findService(targets[0], 'api').role).toBe('api');
    expect(() => findService(targets[0], 'zz')).toThrow(/Unknown service/);
  });
});
