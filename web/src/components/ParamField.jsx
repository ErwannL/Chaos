import { Field, INPUT } from './ui.jsx';

/**
 * One input generated from a typed spec (fault params or expectation fields):
 * integer/number (bounded), enum, string, boolean. Nothing is fault-specific.
 */
export default function ParamField({ name, spec, value, onChange, label = name }) {
  const suffix = spec.unit ? ` (${spec.unit})` : '';
  const bounds =
    spec.min !== undefined && spec.max !== undefined ? ` [${spec.min}–${spec.max}]` : '';
  const text = `${label}${suffix}${bounds}`;
  if (spec.type === 'enum') {
    return (
      <Field label={text}>
        <select className={INPUT} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {spec.values.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </Field>
    );
  }
  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {text}
      </label>
    );
  }
  const numeric = spec.type === 'integer' || spec.type === 'number';
  return (
    <Field label={text}>
      <input
        className={INPUT}
        type={numeric ? 'number' : 'text'}
        min={spec.min}
        max={spec.max}
        step={spec.type === 'integer' ? 1 : 'any'}
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : numeric ? Number(raw) : raw);
        }}
      />
    </Field>
  );
}

/** Default values of a spec map, as the server would apply them. */
export function defaults(specs) {
  return Object.fromEntries(
    Object.entries(specs)
      .filter(([, s]) => s.default !== undefined)
      .map(([k, s]) => [k, s.default]),
  );
}
