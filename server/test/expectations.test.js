import { describe, it, expect } from 'vitest';
import { evaluateExpectations, resilienceScore } from '../src/expectations.js';

const W = [{ step: 0, fault: 'x', service: 'api', start: 10_000, end: 20_000 }];
const s = (ts, probe, extra = {}) => ({ ts, probe, ...extra });
const one = (exp, run) => evaluateExpectations([exp], { windows: W, ...run })[0];

describe('expectations', () => {
  it('status_during: unmeasurable, failed, passed; honors step and settle', () => {
    const exp = { type: 'status_during', probe: 'health', status: 503 };
    expect(one(exp, { samples: [s(11_000, 'health', { status: 200 })] }).verdict).toBe(
      'unmeasurable',
    );
    expect(one(exp, { samples: [s(13_000, 'health', { status: 200 })] }).verdict).toBe('failed');
    expect(one(exp, { samples: [s(13_000, 'health', { status: 503 })] }).verdict).toBe('passed');
    expect(
      one({ ...exp, settleS: 0 }, { samples: [s(10_000, 'health', { status: 503 })] }).verdict,
    ).toBe('passed');
    expect(
      one({ ...exp, step: 3 }, { samples: [s(13_000, 'health', { status: 503 })] }).verdict,
    ).toBe('unmeasurable');
    const open = [{ ...W[0], end: null }];
    expect(
      evaluateExpectations([exp], {
        windows: open,
        samples: [s(13_000, 'health', { status: 503 })],
      })[0].verdict,
    ).toBe('unmeasurable');
  });

  it('recovers_within: all outcomes', () => {
    const exp = { type: 'recovers_within', probe: 'health', status: 200, seconds: 5 };
    expect(evaluateExpectations([exp], { windows: [], samples: [] })[0].verdict).toBe(
      'unmeasurable',
    );
    expect(one(exp, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [s(22_000, 'health', { status: 200 })] })).toMatchObject({
      verdict: 'passed',
      message: 'health back to 200 after 2.0s',
    });
    expect(one(exp, { samples: [s(22_000, 'health', { status: 503 })] }).verdict).toBe(
      'unmeasurable',
    );
    expect(one(exp, { samples: [s(26_000, 'health', { status: 503 })] }).verdict).toBe('failed');
    expect(one(exp, { samples: [s(27_000, 'health', { status: 200 })] }).verdict).toBe('failed');
  });

  it('status_component', () => {
    const exp = { type: 'status_component', component: 'db', state: 'DOWN' };
    const st = (v) => s(13_000, 'status', { data: { components: { db: v } } });
    expect(one(exp, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [s(13_000, 'status', {})] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [st('up')] }).verdict).toBe('failed');
    expect(one(exp, { samples: [st('down')] }).verdict).toBe('passed');
    expect(
      one({ ...exp, state: ['degraded', 'down'] }, { samples: [st('degraded')] }).verdict,
    ).toBe('passed');
  });

  it('no_5xx', () => {
    const exp = { type: 'no_5xx', route: '/api/items' };
    const r = (status) => s(13_000, 'route:/api/items', { status });
    expect(one(exp, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [r(null)] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [r(200), r(502)] }).verdict).toBe('failed');
    expect(one(exp, { samples: [r(200), r(null)] }).verdict).toBe('passed');
  });

  it('frontend expectations', () => {
    const b = (extra) => s(13_000, 'browser', extra);
    const shown = { type: 'frontend_error_shown' };
    const notBlank = { type: 'frontend_not_blank' };
    expect(one(shown, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(shown, { samples: [b({ blank: true })] }).verdict).toBe('failed');
    expect(one(shown, { samples: [b({ blank: false, errorShown: false })] }).message).toBe(
      'no error message was displayed',
    );
    expect(
      one(shown, { samples: [b({ blank: false, errorShown: true, errorText: 'Oops' })] }).message,
    ).toBe('error shown: "Oops"');
    expect(one(notBlank, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(notBlank, { samples: [b({ blank: true })] }).verdict).toBe('failed');
    expect(one(notBlank, { samples: [b({ blank: false })] }).verdict).toBe('passed');
  });

  it('service_restarts', () => {
    const exp = { type: 'service_restarts', service: 'api', seconds: 5, bySelf: false };
    const c = (ts, extra) =>
      s(ts, 'container:api', {
        running: true,
        paused: false,
        restartCount: 0,
        startedAt: 'a',
        ...extra,
      });
    expect(evaluateExpectations([exp], { windows: [], samples: [] })[0].verdict).toBe(
      'unmeasurable',
    );
    expect(one(exp, { samples: [c(11_000)] }).message).toMatch(/no api state before/);
    expect(one(exp, { samples: [c(9_000, { error: 'x' })] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [c(9_000), c(12_000, { startedAt: 'b' })] }).verdict).toBe('passed');
    expect(one(exp, { samples: [c(9_000), c(12_000, { restartCount: 1 })] }).verdict).toBe(
      'passed',
    );
    expect(one(exp, { samples: [c(9_000), c(12_000, { running: false })] }).verdict).toBe(
      'unmeasurable',
    );
    expect(one(exp, { samples: [c(9_000)] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [c(9_000), c(16_000, { running: false })] }).message).toBe(
      'api did not restart within 5s',
    );
    const self = { ...exp, bySelf: true, seconds: 30 };
    expect(
      one(self, {
        samples: [c(9_000), c(19_000, { running: false }), c(21_000, { running: false })],
      }).message,
    ).toBe('api did not restart by itself within 30s');
    expect(one(self, { samples: [c(9_000), c(21_000, { startedAt: 'b' })] }).verdict).toBe(
      'failed',
    );
  });

  it('log_errors_below', () => {
    const exp = { type: 'log_errors_below', max: 2 };
    const l = (errors) => s(13_000, 'logs', { data: { errors } });
    expect(one(exp, { samples: [] }).verdict).toBe('unmeasurable');
    expect(one(exp, { samples: [l(3)] }).verdict).toBe('failed');
    expect(one(exp, { samples: [l(2)] }).verdict).toBe('passed');
  });

  it('caps evidence and scores', () => {
    const many = Array.from({ length: 50 }, (_, i) => s(13_000 + i, 'health', { status: 200 }));
    expect(
      one({ type: 'status_during', probe: 'health', status: 503 }, { samples: many }).evidence,
    ).toHaveLength(30);
    expect(resilienceScore([])).toBeNull();
    expect(resilienceScore([{ verdict: 'unmeasurable' }])).toBeNull();
    expect(
      resilienceScore([{ verdict: 'passed' }, { verdict: 'failed' }, { verdict: 'unmeasurable' }]),
    ).toBe(50);
  });
});
