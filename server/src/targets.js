import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ChaosError } from './errors.js';

export const ROLES = ['db', 'cache', 'api', 'frontend', 'worker'];

const url = z.string().url();

const serviceSchema = z
  .object({
    name: z.string().min(1),
    role: z.enum(ROLES),
    port: z.number().int().min(1).max(65535).optional(),
    proxy: z.string().min(1).optional(),
    diskPath: z
      .string()
      .regex(/^\/[\w./-]+$/, 'diskPath must be an absolute path')
      .refine((p) => !p.split('/').includes('..'), 'diskPath must not contain ..')
      .optional(),
  })
  .strict();

const targetSchema = z
  .object({
    name: z.string().regex(/^[\w-]+$/),
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'invalid compose project name'),
    environment: z.string().min(1),
    baseUrl: url.optional(),
    toxiproxy: z.object({ url }).strict().optional(),
    services: z.array(serviceSchema).min(1),
    probes: z
      .object({
        health: url.optional(),
        liveness: url.optional(),
        status: z
          .union([url, z.object({ url, componentsPath: z.string().optional() }).strict()])
          .optional(),
        metrics: z
          .union([
            url,
            z
              .object({ url, token: z.string().optional(), tokenEnv: z.string().optional() })
              .strict(),
          ])
          .optional(),
        logs: z
          .object({ url, selector: z.string().min(1), errorFilter: z.string().optional() })
          .strict()
          .optional(),
        intervalMs: z.number().int().min(200).max(60_000).optional(),
        timeoutMs: z.number().int().min(100).max(30_000).optional(),
      })
      .strict()
      .default({}),
    frontendUrl: url.optional(),
  })
  .strict();

const fileSchema = z.object({ targets: z.array(targetSchema).min(1) }).strict();

function normalizeProbes(p, env) {
  const status = typeof p.status === 'string' ? { url: p.status } : p.status;
  const metrics = typeof p.metrics === 'string' ? { url: p.metrics } : p.metrics;
  if (metrics && metrics.tokenEnv) metrics.token = env[metrics.tokenEnv];
  return {
    health: p.health,
    liveness: p.liveness,
    status: status && { componentsPath: 'components', ...status },
    metrics: metrics && { url: metrics.url, token: metrics.token },
    logs: p.logs,
    intervalMs: p.intervalMs ?? 1000,
    timeoutMs: p.timeoutMs ?? 2000,
  };
}

/** Validates a parsed targets document and returns normalized targets. */
export function parseTargets(doc, env = process.env) {
  const res = fileSchema.safeParse(doc);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ChaosError('CONFIG_INVALID', `Invalid targets config: ${msg}`, 500);
  }
  const names = new Set();
  return res.data.targets.map((t) => {
    if (names.has(t.name)) throw new ChaosError('CONFIG_INVALID', `Duplicate target ${t.name}`);
    names.add(t.name);
    const svc = new Set();
    for (const s of t.services) {
      if (svc.has(s.name)) throw new ChaosError('CONFIG_INVALID', `Duplicate service ${s.name}`);
      svc.add(s.name);
      if (s.proxy && !t.toxiproxy)
        throw new ChaosError('CONFIG_INVALID', `Service ${s.name} has a proxy but no toxiproxy`);
    }
    return { ...t, probes: normalizeProbes(t.probes, env) };
  });
}

export function loadTargets(path, env = process.env) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ChaosError('CONFIG_MISSING', `Cannot read ${path}: ${e.message}`, 500);
  }
  return parseTargets(parse(text), env);
}

export function findTarget(targets, name) {
  const t = targets.find((x) => x.name === name);
  if (!t) throw new ChaosError('TARGET_UNKNOWN', `Unknown target ${name}`, 404);
  return t;
}

export function findService(target, name) {
  const s = target.services.find((x) => x.name === name);
  if (!s) throw new ChaosError('SERVICE_UNKNOWN', `Unknown service ${name} in ${target.name}`);
  return s;
}

/** Public, secret-free view of a target. */
export function publicTarget(t) {
  const { metrics } = t.probes;
  return {
    ...t,
    probes: { ...t.probes, metrics: metrics && { url: metrics.url, hasToken: !!metrics.token } },
  };
}
