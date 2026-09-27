import { Field, INPUT } from './ui.jsx';
import ParamField, { defaults } from './ParamField.jsx';

/** Editor for one expectation, generated from GET /expectation-types. */
export default function ExpectationStep({ exp, onChange, types }) {
  const fields = types[exp.type];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Field label="type">
        <select
          className={INPUT}
          value={exp.type}
          onChange={(e) => onChange({ type: e.target.value, ...defaults(types[e.target.value]) })}
        >
          {Object.keys(types).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </Field>
      {Object.entries(fields).map(([k, spec]) => (
        <ParamField
          key={k}
          name={k}
          spec={spec}
          value={exp[k]}
          onChange={(v) => onChange({ ...exp, [k]: v })}
        />
      ))}
    </div>
  );
}
