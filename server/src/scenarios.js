import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ChaosError } from './errors.js';

const route = z.string().regex(/^\/[\w\-./?=&%]*$/, 'route must be a path starting with /');
const window = {
  step: z.number().int().min(0).optional(),
  settleS: z.number().min(0).max(60).optional(),
};
const probeName = z.enum(['health', 'liveness', 'status', 'metrics']);

const PROBE = { type: 'enum', values: ['health', 'liveness', 'status', 'metrics'], required: true };
const WINDOW = {
  step: { type: 'integer', min: 0 },
  settleS: { type: 'number', min: 0, max: 60 },
};

/** Field specs of each expectation type (drives the UI editor). */
export const EXPECTATION_FIELDS = {
  status_during: {
    probe: PROBE,
    status: { type: 'integer', required: true, default: 503 },
    ...WINDOW,
  },
  recovers_within: {
    probe: PROBE,
    status: { type: 'integer', default: 200 },
    seconds: { type: 'number', min: 0, max: 3600, required: true, default: 10 },
  },
  status_component: {
    component: { type: 'string', required: true },
    state: { type: 'string', required: true, default: 'down' },
    ...WINDOW,
  },
  no_5xx: { route: { type: 'string', required: true, default: '/' }, ...WINDOW },
  frontend_error_shown: WINDOW,
  frontend_not_blank: WINDOW,
  service_restarts: {
    service: { type: 'string', required: true },
    seconds: { type: 'number', min: 0, max: 600, required: true, default: 30 },
    bySelf: { type: 'boolean', default: false },
    ...WINDOW,
  },
  log_errors_below: { max: { type: 'number', min: 0, required: true, default: 0 }, ...WINDOW },
};

const expectationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('status_during'),
      probe: probeName,
      status: z.number().int(),
      ...window,
    })
    .strict(),
  z
    .object({
      type: z.literal('recovers_within'),
      probe: probeName,
      status: z.number().int().default(200),
      seconds: z.number().positive().max(3600),
    })
    .strict(),
  z
    .object({
      type: z.literal('status_component'),
      component: z.string().min(1),
      state: z.union([z.string(), z.array(z.string()).min(1)]),
      ...window,
    })
    .strict(),
  z.object({ type: z.literal('no_5xx'), route, ...window }).strict(),
  z.object({ type: z.literal('frontend_error_shown'), ...window }).strict(),
  z.object({ type: z.literal('frontend_not_blank'), ...window }).strict(),
  z
    .object({
      type: z.literal('service_restarts'),
      service: z.string().min(1),
      seconds: z.number().positive().max(600),
      bySelf: z.boolean().default(false),
      ...window,
    })
    .strict(),
  z.object({ type: z.literal('log_errors_below'), max: z.number().min(0), ...window }).strict(),
]);

const stepSchema = z.union([
  z
    .object({
      fault: z.string().min(1),
      service: z.string().min(1),
      durationS: z.number().positive(),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z.object({ pause: z.number().positive().max(3600) }).strict(),
]);

export const scenarioSchema = z
  .object({
    name: z.string().regex(/^[\w-]+$/, 'name: letters, digits, - and _ only'),
    description: z.string().optional(),
    baselineS: z.number().min(0).max(600).default(3),
    recoveryS: z.number().min(0).max(3600).default(10),
    watch: z.array(route).default([]),
    steps: z.array(stepSchema).min(1),
    expectations: z.array(expectationSchema).default([]),
  })
  .strict();

export function parseScenario(doc) {
  const res = scenarioSchema.safeParse(doc);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ChaosError('SCENARIO_INVALID', `Invalid scenario: ${msg}`);
  }
  return res.data;
}

/** Scenario files live in a directory, one YAML file per scenario. */
export function createScenarioRepo({ dir }) {
  mkdirSync(dir, { recursive: true });
  const files = () => readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  function all() {
    return files().map((f) => {
      try {
        return { ...parseScenario(parse(readFileSync(join(dir, f), 'utf8'))), file: f };
      } catch (e) {
        return { name: f.replace(/\.ya?ml$/, ''), file: f, invalid: e.message };
      }
    });
  }
  return {
    list: all,
    get(name) {
      const s = all().find((x) => x.name === name);
      if (!s) throw new ChaosError('SCENARIO_UNKNOWN', `Unknown scenario ${name}`, 404);
      if (s.invalid) throw new ChaosError('SCENARIO_INVALID', s.invalid);
      return s;
    },
    save(doc) {
      const s = parseScenario(doc);
      writeFileSync(join(dir, `${s.name}.yaml`), stringify(s));
      return s;
    },
  };
}
