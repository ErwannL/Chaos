import { useI18n } from '../i18n.jsx';
import { Field, INPUT } from './ui.jsx';
import ParamField, { defaults } from './ParamField.jsx';

/** Editor for one fault step, generated from the catalog entry. */
export default function FaultStep({ step, onChange, catalog, target }) {
  const { t, tr } = useI18n();
  const fault = catalog.find((f) => f.key === step.fault);
  const services = (target?.services ?? []).filter((s) => fault.roles.includes(s.role));
  const set = (patch) => onChange({ ...step, ...patch });
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Field label="fault">
        <select
          className={INPUT}
          value={step.fault}
          onChange={(e) => {
            const f = catalog.find((x) => x.key === e.target.value);
            set({
              fault: f.key,
              params: defaults(f.params),
              durationS: Math.min(step.durationS, f.maxDurationS),
            });
          }}
        >
          {catalog.map((f) => (
            <option key={f.key} value={f.key}>
              {tr(f.title)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('service')}>
        <select
          className={INPUT}
          value={step.service}
          onChange={(e) => set({ service: e.target.value })}
        >
          <option value="">—</option>
          {services.map((s) => (
            <option key={s.name}>{s.name}</option>
          ))}
        </select>
      </Field>
      <ParamField
        name="durationS"
        label={t('duration')}
        spec={{ type: 'integer', min: 1, max: fault.maxDurationS }}
        value={step.durationS}
        onChange={(v) => set({ durationS: v })}
      />
      {Object.entries(fault.params).map(([k, spec]) => (
        <ParamField
          key={k}
          name={k}
          spec={spec}
          value={step.params?.[k]}
          onChange={(v) => set({ params: { ...step.params, [k]: v } })}
        />
      ))}
    </div>
  );
}
