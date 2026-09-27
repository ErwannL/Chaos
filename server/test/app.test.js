import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAppEnv } from './helpers/app-env.js';
import { simFetch } from './helpers/sim.js';
import { parseTargets } from '../src/targets.js';
import { demoTargetDoc } from './helpers/fixtures.js';
import { signHs256 } from '../src/jwt.js';

const bearer = (t) => ({ authorization: `Bearer ${t}` });
async function until(cond) {
  while (!cond()) await new Promise((r) => setTimeout(r, 5));
}

describe('HTTP API', () => {
  it('requires authentication except for auth endpoints', async () => {
    const { app } = makeAppEnv();
    expect((await request(app).get('/catalog')).status).toBe(401);
    expect((await request(app).get('/auth/mode')).body).toEqual({ mode: 'local' });
    const bad = await request(app)
      .post('/auth/login')
      .send({ username: 'admin', password: 'nope' });
    expect(bad.status).toBe(401);
    const ok = await request(app)
      .post('/auth/login')
      .send({ username: 'admin', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    const me = await request(app).get('/auth/me').set(bearer(ok.body.token));
    expect(me.body).toEqual({ user: { sub: 'local:admin', name: 'admin' }, mode: 'local' });
    expect((await request(app).post('/auth/login').send()).status).toBe(401);
  });

  it('exchanges an SSO token received from the URL fragment', async () => {
    const env = {
      CHAOS_SSO_SECRET: 's'.repeat(32),
      CHAOS_SESSION_SECRET: 'k'.repeat(32),
      CHAOS_SSO_ISSUERS: 'console',
    };
    const { app, world } = makeAppEnv({ env });
    const now = Math.floor(world.clock.now() / 1000);
    const sso = signHs256(
      { iss: 'console', aud: 'chaos', sub: 'u', name: 'Ada', iat: now, exp: now + 60 },
      env.CHAOS_SSO_SECRET,
    );
    const res = await request(app).post('/auth/sso').send({ token: sso });
    expect(res.status).toBe(200);
    expect((await request(app).get('/catalog').set(bearer(res.body.token))).status).toBe(200);
    expect((await request(app).post('/auth/sso').send({ token: sso })).status).toBe(401);
    expect(
      (await request(app).post('/auth/login').send({ username: 'a', password: 'b' })).status,
    ).toBe(404);
  });

  it('serves the catalog generated from code', async () => {
    const { app, token } = makeAppEnv();
    const res = await request(app).get('/catalog').set(bearer(token));
    expect(res.body.map((f) => f.key)).toContain('disk_pressure');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  });

  it('lists targets with guard verdict and live probes', async () => {
    const [prod] = parseTargets(
      { targets: [demoTargetDoc({ name: 'prod', environment: 'prod' })] },
      {},
    );
    const env = makeAppEnv();
    env.ctx.targets = () => [env.world.target, prod];
    const res = await request(env.app).get('/targets').set(bearer(env.token));
    expect(res.body[0].verdict.allowed).toBe(true);
    expect(res.body[0].live.map((s) => [s.probe, s.status])).toEqual([
      ['health', 200],
      ['liveness', 200],
      ['status', 200],
    ]);
    expect(res.body[1]).toMatchObject({
      verdict: { allowed: false, reasons: [{ code: 'ENV_PRODUCTION' }] },
    });
    expect(res.body[1].live).toBeUndefined();
    const noLive = await request(env.app).get('/targets?live=0').set(bearer(env.token));
    expect(noLive.body[0].live).toBeUndefined();
  });

  it('POST /plan validates without executing', async () => {
    const { app, token, world } = makeAppEnv();
    const res = await request(app)
      .post('/plan')
      .set(bearer(token))
      .send({ scenario: 'db-outage', target: 'demo' });
    expect(res.body).toMatchObject({ ok: true, target: { allowed: true } });
    expect(world.toxiproxy.calls).toEqual([]);
    const inline = await request(app)
      .post('/plan')
      .set(bearer(token))
      .send({
        scenario: { name: 'x', steps: [{ fault: 'latency', service: 'web', durationS: 1 }] },
        target: 'demo',
      });
    expect(inline.body.errors[0].code).toBe('FAULT_INCOMPATIBLE');
    const bad = await request(app).post('/plan').set(bearer(token)).send({ scenario: 'db-outage' });
    expect(bad.status).toBe(400);
    const broken = await request(app)
      .post('/plan')
      .set(bearer(token))
      .send({ scenario: { name: 'x' }, target: 'demo' });
    expect(broken.body.error.code).toBe('SCENARIO_INVALID');
  });

  it('runs a scenario, streams it (SSE) and exports the report', async () => {
    const { app, token } = makeAppEnv();
    const start = await request(app)
      .post('/runs')
      .set(bearer(token))
      .send({ scenario: 'db-outage', target: 'demo' });
    expect(start.status).toBe(202);
    const { id } = start.body;
    const sse = await request(app)
      .get(`/runs/${id}`)
      .set(bearer(token))
      .set('accept', 'text/event-stream');
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.text).toContain('event: finished');
    const json = await request(app).get(`/runs/${id}`).set(bearer(token));
    expect(json.body.report).toMatchObject({ status: 'passed', score: 100, actor: 'admin' });
    const list = await request(app).get('/runs').set(bearer(token));
    expect(list.body).toMatchObject({ active: null, runs: [{ id, status: 'passed' }] });
    const html = await request(app).get(`/runs/${id}/report.html?lang=en`).set(bearer(token));
    expect(html.headers['content-disposition']).toContain(`chaos-${id}.html`);
    expect(html.text).toContain('Resilience score');
    const fr = await request(app).get(`/runs/${id}/report.html`).set(bearer(token));
    expect(fr.text).toContain('Score de résilience');
    const journal = await request(app).get('/journal').set(bearer(token));
    expect(journal.body[0]).toMatchObject({
      actor: 'admin',
      fault: 'connection_reset',
      revertOk: true,
    });
    expect((await request(app).get('/runs/nope').set(bearer(token))).status).toBe(404);
  });

  it('streams live events then closes, and returns 409 on a concurrent run', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let env;
    env = makeAppEnv({
      fetchImpl: async (url) => {
        await gate;
        return simFetch(env.world)(url);
      },
    });
    const { app, token } = env;
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const h = { ...bearer(token), 'content-type': 'application/json' };
    const { id } = await (
      await fetch(`${base}/runs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ scenario: 'cache-outage', target: 'demo' }),
      })
    ).json();
    const conflict = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ scenario: 'cache-outage', target: 'demo' }),
    });
    expect(conflict.status).toBe(409);
    expect((await (await fetch(`${base}/runs/${id}`, { headers: h })).json()).events[0].type).toBe(
      'status',
    );
    const stream = await fetch(`${base}/runs/${id}`, {
      headers: { ...h, accept: 'text/event-stream' },
    });
    release();
    const text = await stream.text();
    expect(text).toContain('event: inject');
    expect(text.trim().split('\n\n').at(-1)).toContain('event: finished');
    server.close();
  });

  it('abort endpoints revert and report', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let env;
    env = makeAppEnv({
      fetchImpl: async (url) => {
        await gate;
        return simFetch(env.world)(url);
      },
    });
    const { app, token } = env;
    const { id } = (
      await request(app)
        .post('/runs')
        .set(bearer(token))
        .send({ scenario: 'db-outage', target: 'demo' })
    ).body;
    const abort = request(app)
      .post(`/runs/${id}/abort`)
      .set(bearer(token))
      .then((r) => r);
    await until(() => env.runner.get(id).controller.signal.aborted);
    release();
    const res = await abort;
    expect(res.body, JSON.stringify(res.body)).toEqual({ id, status: 'aborted' });
    expect((await request(app).post(`/runs/${id}/abort`).set(bearer(token))).status).toBe(409);
    expect((await request(app).post('/abort-all').set(bearer(token))).body).toEqual({
      aborted: null,
    });
  });

  it('abort-all cancels the active run', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let env;
    env = makeAppEnv({
      fetchImpl: async (url) => {
        await gate;
        return simFetch(env.world)(url);
      },
    });
    const { id } = (
      await request(env.app)
        .post('/runs')
        .set(bearer(env.token))
        .send({ scenario: 'db-outage', target: 'demo' })
    ).body;
    const p = request(env.app)
      .post('/abort-all')
      .set(bearer(env.token))
      .then((r) => r);
    await until(() => env.runner.get(id).controller.signal.aborted);
    release();
    expect((await p).body).toEqual({ aborted: id });
  });

  it('refuses production and unconfirmed remote targets with 403', async () => {
    const [prod] = parseTargets({ targets: [demoTargetDoc({ environment: 'production' })] }, {});
    const { app, token, world } = makeAppEnv({ targets: [prod] });
    const res = await request(app)
      .post('/runs')
      .set(bearer(token))
      .send({ scenario: 'db-outage', target: 'demo', allowRemote: true, confirmHost: '127.0.0.1' });
    expect(res.status).toBe(403);
    expect(res.body.error.details.target.reasons[0].code).toBe('ENV_PRODUCTION');
    expect(world.toxiproxy.calls).toEqual([]);

    const [remote] = parseTargets(
      { targets: [demoTargetDoc({ baseUrl: 'http://10.1.2.3:80' })] },
      {},
    );
    const r2 = makeAppEnv({ targets: [remote] });
    const refused = await request(r2.app).post('/runs').set(bearer(r2.token)).send({
      scenario: 'db-outage',
      target: 'demo',
      allowRemote: 'true',
      confirmHost: '10.1.2.3',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.target.reasons[0].code).toBe('REMOTE_HOST');
  });

  it('saves scenarios from the editor', async () => {
    const { app, token } = makeAppEnv();
    const doc = { name: 'mine', steps: [{ pause: 1 }] };
    expect((await request(app).put('/scenarios/mine').set(bearer(token)).send(doc)).status).toBe(
      200,
    );
    expect((await request(app).put('/scenarios/other').set(bearer(token)).send(doc)).status).toBe(
      400,
    );
    const list = await request(app).get('/scenarios').set(bearer(token));
    expect(list.body.map((s) => s.name)).toContain('mine');
  });

  it('handles bad JSON, unknown routes and internal errors', async () => {
    const env = makeAppEnv();
    const bad = await request(env.app)
      .post('/plan')
      .set(bearer(env.token))
      .set('content-type', 'application/json')
      .send('{');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    expect((await request(env.app).get('/nope').set(bearer(env.token))).status).toBe(404);
    env.ctx.journal.entries = () => {
      throw new Error('disk on fire');
    };
    const boom = await request(env.app).get('/journal').set(bearer(env.token));
    expect(boom.status).toBe(500);
    expect(boom.body.error).toMatchObject({ code: 'INTERNAL', message: 'disk on fire' });
  });

  it('serves the built UI with SPA fallback', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(webDir, 'index.html'), '<div id=root></div>');
    const { app } = makeAppEnv({ config: { webDir } });
    expect((await request(app).get('/')).text).toContain('root');
    expect((await request(app).get('/some/page').set('accept', 'text/html')).text).toContain(
      'root',
    );
    expect((await request(app).get('/catalog')).status).toBe(401);
  });
});
