import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Loads `path` (and re-loads every `pollMs` when set). */
export function useApi(path, pollMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(
    () =>
      api(path).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(e),
      ),
    [path],
  );
  useEffect(() => {
    load();
    if (!pollMs) return undefined;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return { data, error, reload: load };
}
