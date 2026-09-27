import { ChaosError } from '../errors.js';

function invalid(key, msg) {
  return new ChaosError('PARAM_INVALID', `Parameter ${key}: ${msg}`);
}

function checkOne(key, spec, value) {
  switch (spec.type) {
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(key, 'not a number');
      if (spec.type === 'integer' && !Number.isInteger(value)) throw invalid(key, 'not an integer');
      if (value < spec.min || value > spec.max) {
        throw invalid(key, `must be between ${spec.min} and ${spec.max}`);
      }
      return value;
    }
    case 'enum':
      if (!spec.values.includes(value)) throw invalid(key, `must be one of ${spec.values}`);
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length > (spec.maxLength ?? 200)) {
        throw invalid(key, 'not a string or too long');
      }
      if (spec.regex) {
        try {
          new RegExp(value);
        } catch {
          throw invalid(key, 'not a valid regular expression');
        }
      }
      return value;
    default:
      throw invalid(key, `unknown type ${spec.type}`);
  }
}

/** Validates params against a fault's typed spec, applies defaults, refuses unknown keys. */
export function validateParams(fault, params = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ChaosError('PARAM_INVALID', 'params must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!(key in fault.params)) throw invalid(key, `unknown for ${fault.key}`);
  }
  const out = {};
  for (const [key, spec] of Object.entries(fault.params)) {
    const value = params[key] ?? spec.default;
    out[key] = checkOne(key, spec, value);
  }
  return out;
}
