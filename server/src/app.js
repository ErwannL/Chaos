import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ChaosError } from './errors.js';
import { publicTarget } from './targets.js';
import { targetVerdict } from './guards.js';
import { parseScenario, EXPECTATION_FIELDS } from './scenarios.js';
import { createProber } from './probes.js';
import { renderReportHtml } from './report-html.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function runInput(ctx, body = {}) {
  if (typeof body.target !== 'string') throw new ChaosError('BAD_REQUEST', 'target is required');
  const scenario =
    typeof body.scenario === 'string'
      ? ctx.scenarios.get(body.scenario)
      : parseScenario(body.scenario);
  return {
    scenario,
    target: body.target,
    allowRemote: body.allowRemote === true,
    confirmHost: body.confirmHost,
  };
}

function liveView(run) {
  if (run.report) return { id: run.id, status: run.status, report: run.report };
  return { id: run.id, status: run.status, events: run.events };
}

/** Builds the Express app. `ctx` comes from createContext (or test fakes). */
export function createApp({ ctx, auth, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors ${config.frameAncestors}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();

  // `orqeaUrl`: where « Revenir sur Orqea » leads in THIS environment (CHAOS_ORQEA_URL).
  api.get('/auth/mode', (_req, res) => res.json({ mode: auth.mode, orqeaUrl: config.orqeaUrl }));
  api.post('/auth/sso', (req, res) => res.json(auth.exchangeSso(req.body?.token)));
  api.post('/auth/login', (req, res) =>
    res.json(auth.loginLocal(String(req.body?.username ?? ''), String(req.body?.password ?? ''))),
  );

  api.use(auth.middleware);
  api.get('/auth/me', (req, res) => res.json({ user: req.user, mode: auth.mode }));

  api.get('/catalog', (_req, res) => res.json(ctx.catalog.describe()));
  api.get('/expectation-types', (_req, res) => res.json(EXPECTATION_FIELDS));

  api.get(
    '/targets',
    wrap(async (req, res) => {
      const live = req.query.live !== '0';
      const out = await Promise.all(
        ctx.targets().map(async (t) => {
          const view = { ...publicTarget(t), verdict: targetVerdict(t) };
          if (live && view.verdict.allowed) {
            const prober = createProber({ target: t, fetchImpl: ctx.fetchImpl, clock: ctx.clock });
            view.live = await prober.sample({ include: ['health', 'liveness', 'status'] });
          }
          return view;
        }),
      );
      res.json(out);
    }),
  );

  api.get('/scenarios', (_req, res) => res.json(ctx.scenarios.list()));
  api.put('/scenarios/:name', (req, res) => {
    if (req.body?.name !== req.params.name) {
      throw new ChaosError('BAD_REQUEST', 'name in body must match the URL');
    }
    res.json(ctx.scenarios.save(req.body));
  });

  api.post('/plan', (req, res) => res.json(ctx.runner.plan(runInput(ctx, req.body))));

  api.get('/runs', (_req, res) =>
    res.json({ active: ctx.runner.active(), runs: ctx.store.list() }),
  );
  api.post('/runs', (req, res) => {
    const { id, plan } = ctx.runner.start(runInput(ctx, req.body), req.user.name);
    res.status(202).json({ id, plan });
  });
  api.post(
    '/abort-all',
    wrap(async (_req, res) => {
      const report = await ctx.runner.abortAll();
      res.json({ aborted: report ? report.id : null });
    }),
  );
  api.post(
    '/runs/:id/abort',
    wrap(async (req, res) => {
      const report = await ctx.runner.abort(req.params.id);
      res.json({ id: report.id, status: report.status });
    }),
  );
  api.get('/runs/:id/report.html', (req, res) => {
    const report = ctx.store.get(req.params.id);
    res
      .type('html')
      .set('content-disposition', `attachment; filename="chaos-${report.id}.html"`)
      .send(renderReportHtml(report, req.query.lang === 'en' ? 'en' : 'fr'));
  });
  api.get('/runs/:id', (req, res) => {
    const run = ctx.runner.get(req.params.id);
    if (!String(req.get('accept')).includes('text/event-stream')) {
      return res.json(liveView(run));
    }
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of run.events) send(e);
    if (run.report) {
      send({ type: 'finished', status: run.status, score: run.report.score });
      return res.end();
    }
    const off = ctx.runner.subscribe(run.id, (e) => {
      send(e);
      if (e.type === 'finished') {
        off();
        res.end();
      }
    });
    req.on('close', off);
  });

  api.get('/journal', (_req, res) => res.json(ctx.journal.entries()));

  if (config.webDir && existsSync(config.webDir)) {
    app.use(express.static(config.webDir, { index: 'index.html' }));
    // Browser navigations (Accept: text/html) get the SPA; API calls go on.
    app.get('/{*splat}', (req, res, next) =>
      String(req.get('accept')).includes('text/html')
        ? res.sendFile(join(config.webDir, 'index.html'))
        : next(),
    );
  }
  app.use(api);

  app.use((req, _res, next) =>
    next(new ChaosError('NOT_FOUND', `No route ${req.method} ${req.path}`, 404)),
  );
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    const code = err.code ?? (status === 400 ? 'BAD_REQUEST' : 'INTERNAL');
    res.status(status).json({ error: { code, message: err.message, details: err.details } });
  });
  return app;
}
