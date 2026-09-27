import { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useApi } from '../useApi.js';
import { Badge, Button, Card, ErrorBox, Field, INPUT } from '../components/ui.jsx';
import FaultStep from '../components/FaultStep.jsx';
import ExpectationStep from '../components/ExpectationStep.jsx';
import { defaults } from '../components/ParamField.jsx';

const EMPTY = {
  name: 'new-scenario',
  description: '',
  baselineS: 3,
  recoveryS: 10,
  watch: [],
  steps: [],
  expectations: [],
};

/** Drops empty optional values so the server applies its own defaults. */
function clean(doc) {
  const strip = (o) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  return {
    ...strip({ ...doc, file: undefined, invalid: undefined }),
    steps: doc.steps.map((s) => ('pause' in s ? s : { ...s, params: strip(s.params ?? {}) })),
    expectations: doc.expectations.map(strip),
  };
}

export default function ScenarioEditor({ catalog, targets, types, initial, onRun }) {
  const { t } = useI18n();
  const saved = useApi('/scenarios');
  const [doc, setDoc] = useState(initial ?? EMPTY);
  const [target, setTarget] = useState(targets[0]?.name ?? '');
  const [allowRemote, setAllowRemote] = useState(false);
  const [confirmHost, setConfirmHost] = useState('');
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const tgt = targets.find((x) => x.name === target);
  const set = (patch) => setDoc({ ...doc, ...patch });
  const setStep = (i, s) => set({ steps: doc.steps.map((x, j) => (j === i ? s : x)) });
  const setExp = (i, e) => set({ expectations: doc.expectations.map((x, j) => (j === i ? e : x)) });
  const body = () => ({ scenario: clean(doc), target, allowRemote, confirmHost });

  async function call(fn) {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
      if (e.details?.target) setPlan(e.details);
    }
  }
  const save = () =>
    call(async () => {
      await api(`/scenarios/${encodeURIComponent(doc.name)}`, { method: 'PUT', body: clean(doc) });
      setNotice(t('saved'));
      saved.reload();
    });
  const validate = () =>
    call(async () => setPlan(await api('/plan', { method: 'POST', body: body() })));
  const run = () =>
    call(async () => {
      const r = await api('/runs', { method: 'POST', body: body() });
      onRun(r.id);
    });

  const firstFault = catalog[0];
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card>
        <Button className="mb-2 w-full" onClick={() => setDoc(EMPTY)}>
          {t('newScenario')}
        </Button>
        <ul className="text-sm">
          {(saved.data ?? []).map((s) => (
            <li key={s.name}>
              <button
                type="button"
                className="hover:underline"
                disabled={!!s.invalid}
                onClick={() => setDoc(s)}
              >
                {s.name} {s.invalid && <Badge tone="red">!</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="flex flex-col gap-4">
        <Card className="grid gap-2 sm:grid-cols-2">
          <Field label={t('name')}>
            <input
              className={INPUT}
              value={doc.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={t('description')}>
            <input
              className={INPUT}
              value={doc.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field label={t('baselineS')}>
            <input
              className={INPUT}
              type="number"
              value={doc.baselineS}
              onChange={(e) => set({ baselineS: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('recoveryS')}>
            <input
              className={INPUT}
              type="number"
              value={doc.recoveryS}
              onChange={(e) => set({ recoveryS: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('watch')}>
            <textarea
              className={INPUT}
              value={doc.watch.join('\n')}
              onChange={(e) => set({ watch: e.target.value.split('\n').filter(Boolean) })}
            />
          </Field>
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">{t('steps')}</h2>
          {doc.steps.map((s, i) => (
            <div key={i} className="mb-3 flex items-end gap-2 border-b border-neutral-800 pb-3">
              <span className="text-xs text-neutral-500">#{i}</span>
              <div className="flex-1">
                {'pause' in s ? (
                  <Field label={t('pause')}>
                    <input
                      className={INPUT}
                      type="number"
                      value={s.pause}
                      onChange={(e) => setStep(i, { pause: Number(e.target.value) })}
                    />
                  </Field>
                ) : (
                  <FaultStep
                    step={s}
                    onChange={(v) => setStep(i, v)}
                    catalog={catalog}
                    target={tgt}
                  />
                )}
              </div>
              <Button onClick={() => set({ steps: doc.steps.filter((_, j) => j !== i) })}>
                {t('remove')}
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              onClick={() =>
                set({
                  steps: [
                    ...doc.steps,
                    {
                      fault: firstFault.key,
                      service: '',
                      durationS: 10,
                      params: defaults(firstFault.params),
                    },
                  ],
                })
              }
            >
              {t('addFault')}
            </Button>
            <Button onClick={() => set({ steps: [...doc.steps, { pause: 5 }] })}>
              {t('addPause')}
            </Button>
          </div>
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">{t('expectations')}</h2>
          {doc.expectations.map((x, i) => (
            <div key={i} className="mb-3 flex items-end gap-2 border-b border-neutral-800 pb-3">
              <div className="flex-1">
                <ExpectationStep exp={x} onChange={(v) => setExp(i, v)} types={types} />
              </div>
              <Button
                onClick={() => set({ expectations: doc.expectations.filter((_, j) => j !== i) })}
              >
                {t('remove')}
              </Button>
            </div>
          ))}
          <Button
            onClick={() => {
              const type = Object.keys(types)[0];
              set({ expectations: [...doc.expectations, { type, ...defaults(types[type]) }] });
            }}
          >
            {t('addExpectation')}
          </Button>
        </Card>
        <Card className="flex flex-wrap items-end gap-3">
          <Field label={t('target')}>
            <select className={INPUT} value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((x) => (
                <option key={x.name}>{x.name}</option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowRemote}
              onChange={(e) => setAllowRemote(e.target.checked)}
            />
            {t('allowRemote')}
          </label>
          {allowRemote && (
            <Field label={t('confirmHost')}>
              <input
                className={INPUT}
                value={confirmHost}
                onChange={(e) => setConfirmHost(e.target.value)}
              />
            </Field>
          )}
          <Button onClick={save}>{t('save')}</Button>
          <Button onClick={validate}>{t('plan')}</Button>
          <Button kind="primary" onClick={run}>
            {t('run')}
          </Button>
          {notice && <Badge tone="green">{notice}</Badge>}
        </Card>
        <ErrorBox error={error} />
        {plan && (
          <Card>
            <Badge tone={plan.ok ? 'green' : 'red'}>{plan.ok ? t('planOk') : t('planKo')}</Badge>{' '}
            <span className="text-sm">
              {t('estimated')}: {plan.estimatedDurationS}s
            </span>
            <ul className="mt-2 text-sm">
              {plan.errors.map((e, i) => (
                <li key={i} className="text-red-500">
                  {e.code}: {e.message}
                </li>
              ))}
              {plan.warnings.map((w, i) => (
                <li key={`w${i}`} className="text-amber-500">
                  {w}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
