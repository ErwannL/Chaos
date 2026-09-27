import { randomUUID } from 'node:crypto';
import { ChaosError } from './errors.js';
import { assertDuration, assertTargetAllowed, targetVerdict } from './guards.js';
import { findTarget } from './targets.js';
import { validateParams } from './catalog/params.js';
import { createProber } from './probes.js';
import { evaluateExpectations, resilienceScore } from './expectations.js';
import { acquireRunLock } from './lock.js';

const REVERT_ATTEMPTS = 3;

/**
 * The executor. It knows no fault by name: every fault comes from the
 * catalog, and every injection is journaled and always reverted.
 */
export function createRunner({
  catalog,
  targets,
  journal,
  store,
  drivers,
  clock,
  lockFile,
  fetchImpl,
  idGen = randomUUID,
  log = () => {},
  maxLiveEvents = 5000,
}) {
  const runs = new Map();
  let active = null;

  function plan({ scenario, target: targetName, allowRemote, confirmHost }) {
    const errors = [];
    const warnings = [];
    const target = findTarget(targets(), targetName);
    const verdict = targetVerdict(target, { allowRemote, confirmHost });
    for (const r of verdict.reasons) errors.push({ ...r, guard: true });
    const steps = scenario.steps.map((step, index) => {
      if ('pause' in step) return { index, pause: step.pause };
      const out = { index, fault: step.fault, service: step.service, durationS: step.durationS };
      try {
        const fault = catalog.get(step.fault);
        const service = target.services.find((s) => s.name === step.service);
        if (!service) throw new ChaosError('SERVICE_UNKNOWN', `Unknown service ${step.service}`);
        const why = catalog.incompatibilities(fault, target, service);
        if (why.length) {
          throw new ChaosError(
            'FAULT_INCOMPATIBLE',
            `${fault.key} on ${service.name}: ${why.join(', ')}`,
          );
        }
        out.params = validateParams(fault, step.params);
        assertDuration(fault, step.durationS);
      } catch (e) {
        errors.push({ code: e.code, message: e.message, step: index, guard: e.status === 403 });
      }
      return out;
    });
    const names = new Set(target.services.map((s) => s.name));
    for (const exp of scenario.expectations) {
      if (exp.service && !names.has(exp.service)) {
        errors.push({
          code: 'SERVICE_UNKNOWN',
          message: `Expectation on unknown service ${exp.service}`,
        });
      }
      const probe = exp.probe ?? (exp.type === 'status_component' ? 'status' : null);
      if (probe && !target.probes[probe])
        warnings.push(`Probe ${probe} is not configured: unmeasurable`);
      if (exp.type.startsWith('frontend_') && !steps.some((s) => s.fault?.startsWith('browser_'))) {
        warnings.push(`${exp.type} needs a browser_* step: unmeasurable`);
      }
    }
    const estimatedDurationS =
      scenario.baselineS +
      scenario.recoveryS +
      steps.reduce((acc, s) => acc + (s.pause ?? s.durationS), 0);
    return {
      ok: errors.length === 0,
      target: { name: target.name, environment: target.environment, ...verdict },
      scenario: scenario.name,
      steps,
      errors,
      warnings,
      estimatedDurationS,
    };
  }

  function emit(run, event) {
    const e = { ts: clock.now(), ...event };
    if (run.events.length < maxLiveEvents || event.type !== 'samples') run.events.push(e);
    for (const l of run.listeners) l(e);
  }

  function start(input, actor = 'anonymous') {
    const p = plan(input);
    if (!p.ok) {
      const guard = p.errors.some((e) => e.guard);
      throw new ChaosError(
        guard ? 'GUARD_REFUSED' : 'PLAN_INVALID',
        p.errors[0].message,
        guard ? 403 : 400,
        p,
      );
    }
    const target = findTarget(targets(), input.target);
    assertTargetAllowed(target, input); // defense in depth, same server-side comparison
    if (active) {
      throw new ChaosError('RUN_IN_PROGRESS', `Run ${active.id} is in progress`, 409, {
        runId: active.id,
      });
    }
    const id = idGen();
    const release = acquireRunLock(lockFile, id);
    const run = {
      id,
      status: 'running',
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      activeInjections: new Map(),
    };
    runs.set(id, run);
    active = run;
    run.promise = execute(run, { scenario: input.scenario, target, plan: p, actor }).finally(() => {
      release();
      active = null;
    });
    return { id, plan: p };
  }

  async function revertInjection(run, inj, by = 'runner') {
    let lastError;
    for (let attempt = 1; attempt <= REVERT_ATTEMPTS; attempt++) {
      try {
        await inj.fault.revert(inj.ctx, inj.state);
        journal.reverted(inj.journalId, true, { by });
        inj.step.revertOk = true;
        emit(run, { type: 'revert', step: inj.step.index, fault: inj.fault.key, ok: true });
        run.activeInjections.delete(inj.journalId);
        return true;
      } catch (e) {
        lastError = e;
        log(`revert ${inj.fault.key} attempt ${attempt} failed: ${e.message}`);
        if (attempt < REVERT_ATTEMPTS) await clock.sleep(1000);
      }
    }
    journal.reverted(inj.journalId, false, { error: lastError.message, by });
    inj.step.revertOk = false;
    inj.step.error = `revert failed: ${lastError.message}`;
    emit(run, {
      type: 'revert',
      step: inj.step.index,
      fault: inj.fault.key,
      ok: false,
      error: lastError.message,
    });
    run.activeInjections.delete(inj.journalId);
    return false;
  }

  async function execute(run, { scenario, target, plan: p, actor }) {
    const startedAt = clock.now();
    const signal = run.controller.signal;
    const { docker, toxiproxy, browser } = drivers(target);
    const prober = createProber({ target, fetchImpl, clock, docker });
    const samples = [];
    const windows = [];
    const steps = [];
    const errors = [];
    const sessions = new Set();
    const routes = [
      ...new Set([
        ...scenario.watch,
        ...scenario.expectations.filter((e) => e.route).map((e) => e.route),
      ]),
    ];
    const services = [
      ...new Set([
        ...scenario.expectations.filter((e) => e.type === 'service_restarts').map((e) => e.service),
        ...p.steps
          .filter((s) => s.fault && catalog.get(s.fault).kind === 'container')
          .map((s) => s.service),
      ]),
    ];

    async function sampleOnce() {
      const round = await prober.sample({ routes, services });
      const ts = clock.now();
      for (const s of sessions) round.push({ ts, probe: 'browser', ...(await s.observe()) });
      samples.push(...round);
      emit(run, { type: 'samples', samples: round });
    }

    async function observeFor(seconds) {
      const end = clock.now() + seconds * 1000;
      while (!signal.aborted && clock.now() < end) {
        await sampleOnce();
        const left = end - clock.now();
        await clock.sleep(Math.min(target.probes.intervalMs, Math.max(0, left)), signal);
      }
    }

    emit(run, { type: 'status', status: 'running', scenario: scenario.name, target: target.name });
    try {
      emit(run, { type: 'phase', phase: 'baseline' });
      await observeFor(scenario.baselineS);
      for (const planned of p.steps) {
        if (signal.aborted) break;
        if (planned.pause !== undefined) {
          emit(run, { type: 'phase', phase: 'pause', step: planned.index });
          await observeFor(planned.pause);
          continue;
        }
        const fault = catalog.get(planned.fault);
        const service = target.services.find((s) => s.name === planned.service);
        const step = {
          ...planned,
          injectedAt: null,
          revertedAt: null,
          revertOk: null,
          error: null,
        };
        steps.push(step);
        const journalId = journal.begin({
          actor,
          runId: run.id,
          target: target.name,
          project: target.project,
          service: service.name,
          fault: fault.key,
          params: planned.params,
        });
        let session = null;
        const ctx = {
          target,
          service,
          docker,
          toxiproxy,
          browser,
          clock,
          signal,
          checkpoint: async (state) => journal.checkpoint(journalId, state),
          attach: (s) => {
            session = s;
            sessions.add(s);
          },
          detach: async () => {
            if (!session) return;
            sessions.delete(session);
            await session.close();
            session = null;
          },
        };
        const inj = { journalId, fault, ctx, state: null, step };
        run.activeInjections.set(journalId, inj);
        const win = {
          step: planned.index,
          fault: fault.key,
          service: service.name,
          start: clock.now(),
          end: null,
        };
        windows.push(win);
        emit(run, {
          type: 'inject',
          step: planned.index,
          fault: fault.key,
          service: service.name,
          params: planned.params,
        });
        try {
          inj.state = await fault.inject(ctx, planned.params);
          journal.injected(journalId, inj.state);
          step.injectedAt = clock.now();
          await observeFor(planned.durationS);
        } catch (e) {
          step.error = e.message;
          errors.push(`step ${planned.index} (${fault.key}): ${e.message}`);
          emit(run, { type: 'error', step: planned.index, message: e.message });
        } finally {
          await revertInjection(run, inj);
          step.revertedAt = clock.now();
          win.end = step.revertedAt;
        }
        if (step.error) break;
      }
      if (!signal.aborted && errors.length === 0) {
        emit(run, { type: 'phase', phase: 'recovery' });
        await observeFor(scenario.recoveryS);
      }
    } catch (e) {
      errors.push(e.message);
    } finally {
      for (const inj of [...run.activeInjections.values()]) await revertInjection(run, inj);
    }

    const results = evaluateExpectations(scenario.expectations, { samples, windows });
    const revertFailed = steps.some((s) => s.revertOk === false);
    let status = 'passed';
    if (signal.aborted) status = 'aborted';
    else if (errors.length || revertFailed) status = 'error';
    else if (results.some((r) => r.verdict === 'failed')) status = 'failed';
    const report = {
      id: run.id,
      scenario: { name: scenario.name, description: scenario.description, steps: scenario.steps },
      target: target.name,
      environment: target.environment,
      project: target.project,
      actor,
      status,
      score: resilienceScore(results),
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      startedAtMs: startedAt,
      windows,
      steps,
      expectations: results,
      errors,
      samples,
    };
    store.save(report);
    run.status = status;
    run.report = report;
    emit(run, { type: 'finished', status, score: report.score });
    return report;
  }

  function get(id) {
    const run = runs.get(id);
    if (run) return run;
    const report = store.get(id);
    return { id, status: report.status, report, events: [], listeners: new Set(), done: true };
  }

  return {
    plan,
    start,
    get,
    subscribe(id, listener) {
      const run = get(id);
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },
    abort(id) {
      const run = runs.get(id);
      if (!run || run.status !== 'running') {
        throw new ChaosError('RUN_NOT_ACTIVE', `Run ${id} is not running`, 409);
      }
      emit(run, { type: 'abort' });
      run.controller.abort();
      return run.promise;
    },
    /** "Cancel everything": aborts the active run and waits for every revert. */
    async abortAll() {
      if (!active) return null;
      const run = active;
      emit(run, { type: 'abort' });
      run.controller.abort();
      return run.promise;
    },
    active: () => active && { id: active.id, status: active.status },
    wait: (id) => runs.get(id).promise,
  };
}
