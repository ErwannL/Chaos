import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { I18nProvider } from '../src/i18n.jsx';

export const CATALOG = [
  {
    key: 'latency',
    kind: 'network',
    title: { fr: 'Latence réseau', en: 'Network latency' },
    description: { fr: 'Ajoute de la latence', en: 'Adds latency' },
    roles: ['db', 'cache'],
    requires: ['proxy'],
    maxDurationS: 600,
    params: {
      latencyMs: { type: 'integer', min: 0, max: 30000, default: 1000, unit: 'ms' },
      mode: { type: 'enum', values: ['a', 'b'], default: 'a' },
    },
  },
  {
    key: 'service_pause',
    kind: 'container',
    title: { fr: 'Pause', en: 'Pause' },
    description: { fr: 'd', en: 'd' },
    roles: ['api', 'db'],
    requires: [],
    maxDurationS: 300,
    params: {},
  },
];

export const TARGETS = [
  {
    name: 'demo',
    environment: 'local',
    project: 'chaos-demo',
    verdict: { allowed: true, reasons: [] },
    services: [
      { name: 'mysql', role: 'db', proxy: 'mysql' },
      { name: 'api', role: 'api' },
    ],
    live: [
      { probe: 'health', status: 200 },
      { probe: 'liveness', status: 404 },
      { probe: 'status', status: 503 },
      { probe: 'metrics', status: null, error: 'timeout' },
    ],
  },
  {
    name: 'prod',
    environment: 'production',
    project: 'p',
    verdict: { allowed: false, reasons: [{ code: 'ENV_PRODUCTION', message: 'refused' }] },
    services: [],
  },
];

export const TYPES = {
  status_during: {
    probe: { type: 'enum', values: ['health', 'liveness'], required: true },
    status: { type: 'integer', required: true, default: 503 },
    settleS: { type: 'number', min: 0, max: 60 },
  },
  service_restarts: {
    service: { type: 'string', required: true },
    bySelf: { type: 'boolean', default: false },
  },
};

export const REPORT = {
  id: 'r1',
  scenario: { name: 'db-outage' },
  target: 'demo',
  environment: 'local',
  actor: 'admin',
  status: 'failed',
  score: 50,
  startedAt: '2026-01-01T00:00:00Z',
  startedAtMs: 1000,
  windows: [{ fault: 'latency', service: 'mysql', start: 2000, end: 5000 }],
  steps: [
    { index: 0, fault: 'latency', service: 'mysql', durationS: 3, revertOk: true, error: null },
    {
      index: 1,
      fault: 'service_pause',
      service: 'api',
      durationS: 3,
      revertOk: false,
      error: 'boom',
    },
  ],
  expectations: [
    {
      type: 'status_during',
      verdict: 'passed',
      message: 'ok',
      evidence: [{ ts: 3000, probe: 'health', status: 503 }],
    },
    { type: 'no_5xx', verdict: 'failed', message: 'bad', evidence: [] },
  ],
  errors: ['something broke'],
  samples: [
    { ts: 1000, probe: 'health', status: 200 },
    { ts: 3000, probe: 'health', status: 503 },
    { ts: 3000, probe: 'container:api', running: false, paused: false },
    { ts: 3000, probe: 'browser', blank: false, errorShown: true },
    { ts: 3500, probe: 'liveness', status: null, error: 'timeout' },
  ],
};

export function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, blob: async () => new Blob(['x']) };
}

export function sseBody(events) {
  const text =
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
    ': comment\n\n';
  const bytes = new TextEncoder().encode(text);
  const half = Math.floor(bytes.length / 2);
  const chunks = [bytes.slice(0, half), bytes.slice(half)];
  return {
    getReader: () => ({
      read: async () =>
        chunks.length ? { value: chunks.shift(), done: false } : { value: undefined, done: true },
    }),
  };
}

/** Routes fetch calls: handlers is { 'METHOD /path': (opts, url) => response }. */
export function mockFetch(handlers) {
  const f = vi.fn(async (url, opts = {}) => {
    const path = String(url).split('?')[0];
    const key = `${opts.method ?? 'GET'} ${path}`;
    const h = handlers[key] ?? handlers[`* ${path}`];
    if (!h) return json({ error: { code: 'NOT_FOUND', message: key } }, 404);
    if (typeof h === 'function') return h(opts, url);
    return 'ok' in h && 'status' in h ? h : json(h);
  });
  globalThis.fetch = f;
  return f;
}

export function renderI18n(ui, lang = 'fr') {
  localStorage.setItem('chaos.lang', lang);
  return render(<I18nProvider>{ui}</I18nProvider>);
}
