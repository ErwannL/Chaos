/**
 * Evaluates scenario expectations against timestamped samples.
 * Each expectation yields passed / failed / unmeasurable plus evidence.
 */
const MAX_EVIDENCE = 30;
const DEFAULT_SETTLE_S = 2;

function verdict(v, message, evidence = []) {
  return { verdict: v, message, evidence: evidence.slice(0, MAX_EVIDENCE) };
}

function faultWindows(exp, windows) {
  const ws = windows.filter((w) => w.end !== null);
  return exp.step === undefined ? ws : ws.filter((w) => w.step === exp.step);
}

function inWindows(samples, windows, settleMs, predicate) {
  return samples.filter(
    (s) => predicate(s) && windows.some((w) => s.ts >= w.start + settleMs && s.ts < w.end),
  );
}

function during(exp, { samples, windows }, predicate) {
  const settleMs = (exp.settleS ?? DEFAULT_SETTLE_S) * 1000;
  return inWindows(samples, faultWindows(exp, windows), settleMs, predicate);
}

const evaluators = {
  status_during(exp, run) {
    const s = during(exp, run, (x) => x.probe === exp.probe);
    if (!s.length) return verdict('unmeasurable', `no ${exp.probe} sample during the fault`);
    const bad = s.filter((x) => x.status !== exp.status);
    if (bad.length) {
      return verdict(
        'failed',
        `${exp.probe}: ${bad.length}/${s.length} samples were not ${exp.status}`,
        bad,
      );
    }
    return verdict('passed', `${exp.probe} = ${exp.status} in ${s.length} samples`, s);
  },

  recovers_within(exp, { samples, windows }) {
    const ended = windows.filter((w) => w.end !== null);
    if (!ended.length) return verdict('unmeasurable', 'no fault was reverted');
    const revertAt = Math.max(...ended.map((w) => w.end));
    const after = samples.filter((x) => x.probe === exp.probe && x.ts >= revertAt);
    if (!after.length) return verdict('unmeasurable', `no ${exp.probe} sample after revert`);
    const ok = after.find((x) => x.status === exp.status);
    const limit = exp.seconds * 1000;
    if (ok && ok.ts - revertAt <= limit) {
      const secs = ((ok.ts - revertAt) / 1000).toFixed(1);
      return verdict('passed', `${exp.probe} back to ${exp.status} after ${secs}s`, [ok]);
    }
    const lastTs = after.at(-1).ts;
    if (!ok && lastTs - revertAt < limit) {
      return verdict('unmeasurable', `observation stopped before ${exp.seconds}s`, after);
    }
    return verdict('failed', `${exp.probe} not ${exp.status} within ${exp.seconds}s`, after);
  },

  status_component(exp, run) {
    const states = [exp.state].flat().map((x) => x.toLowerCase());
    const s = during(exp, run, (x) => x.probe === 'status' && x.data);
    if (!s.length) return verdict('unmeasurable', 'no status sample during the fault');
    const hits = s.filter((x) => states.includes(x.data.components[exp.component]));
    if (hits.length) {
      return verdict('passed', `${exp.component} reported ${states.join('|')}`, hits);
    }
    return verdict('failed', `${exp.component} never reported ${states.join('|')}`, s);
  },

  no_5xx(exp, run) {
    const probe = `route:${exp.route}`;
    const s = during(exp, run, (x) => x.probe === probe);
    if (!s.length) return verdict('unmeasurable', `no sample of ${exp.route} during the fault`);
    const bad = s.filter((x) => x.status >= 500);
    if (bad.length) return verdict('failed', `${bad.length} responses 5xx on ${exp.route}`, bad);
    const answered = s.filter((x) => x.status !== null);
    if (!answered.length) return verdict('unmeasurable', `${exp.route} never answered`, s);
    return verdict('passed', `no 5xx on ${exp.route} in ${s.length} samples`, s);
  },

  frontend_error_shown(exp, run) {
    const s = during(exp, run, (x) => x.probe === 'browser');
    if (!s.length) return verdict('unmeasurable', 'no browser observation during the fault');
    const blank = s.filter((x) => x.blank);
    if (blank.length)
      return verdict('failed', `blank screen in ${blank.length} observations`, blank);
    const shown = s.filter((x) => x.errorShown);
    if (!shown.length) return verdict('failed', 'no error message was displayed', s);
    return verdict('passed', `error shown: "${shown[0].errorText}"`, shown);
  },

  frontend_not_blank(exp, run) {
    const s = during(exp, run, (x) => x.probe === 'browser');
    if (!s.length) return verdict('unmeasurable', 'no browser observation during the fault');
    const blank = s.filter((x) => x.blank);
    if (blank.length)
      return verdict('failed', `blank screen in ${blank.length} observations`, blank);
    return verdict('passed', `page rendered in ${s.length} observations`, s);
  },

  service_restarts(exp, { samples, windows }) {
    const probe = `container:${exp.service}`;
    const all = samples.filter((x) => x.probe === probe);
    const ws = faultWindows(exp, windows).filter((w) => w.service === exp.service);
    if (!ws.length) return verdict('unmeasurable', `no fault window on ${exp.service}`);
    const w = ws[0];
    const base = all.filter((x) => x.ts < w.start && !x.error).at(-1);
    if (!base) return verdict('unmeasurable', `no ${exp.service} state before the fault`);
    const limit = w.start + exp.seconds * 1000;
    const until = exp.bySelf ? Math.min(limit, w.end) : limit;
    const after = all.filter((x) => x.ts >= w.start);
    const back = after.find(
      (x) =>
        x.ts <= until &&
        x.running &&
        !x.paused &&
        (x.restartCount > base.restartCount || x.startedAt !== base.startedAt),
    );
    if (back) {
      return verdict(
        'passed',
        `${exp.service} restarted after ${((back.ts - w.start) / 1000).toFixed(1)}s`,
        [base, back],
      );
    }
    if (!after.length || after.at(-1).ts < until) {
      return verdict('unmeasurable', `observation too short for ${exp.seconds}s`, [base, ...after]);
    }
    const how = exp.bySelf ? ' by itself' : '';
    return verdict('failed', `${exp.service} did not restart${how} within ${exp.seconds}s`, [
      base,
      ...after,
    ]);
  },

  log_errors_below(exp, run) {
    const s = during(exp, run, (x) => x.probe === 'logs' && x.data);
    if (!s.length) return verdict('unmeasurable', 'no log sample during the fault');
    const bad = s.filter((x) => x.data.errors > exp.max);
    if (bad.length) return verdict('failed', `more than ${exp.max} error log lines`, bad);
    return verdict('passed', `error log lines <= ${exp.max}`, s);
  },
};

export function evaluateExpectations(expectations, run) {
  return expectations.map((exp) => ({ ...exp, ...evaluators[exp.type](exp, run) }));
}

/** Resilience score: share of measurable expectations that passed (null if none). */
export function resilienceScore(results) {
  const measurable = results.filter((r) => r.verdict !== 'unmeasurable');
  if (!measurable.length) return null;
  return Math.round(
    (100 * measurable.filter((r) => r.verdict === 'passed').length) / measurable.length,
  );
}
