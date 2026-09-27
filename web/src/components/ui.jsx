const BTN = {
  primary: 'bg-indigo-600 hover:bg-indigo-500 text-white',
  danger: 'bg-red-600 hover:bg-red-500 text-white',
  ghost:
    'border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-800',
};

export function Button({ kind = 'ghost', className = '', ...props }) {
  return (
    <button
      type="button"
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${BTN[kind]} ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = '' }) {
  return (
    <section
      className={`rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      {children}
    </section>
  );
}

const TONES = {
  green: 'bg-green-600/20 text-green-700 dark:text-green-400',
  red: 'bg-red-600/20 text-red-700 dark:text-red-400',
  amber: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
  gray: 'bg-neutral-500/20 text-neutral-600 dark:text-neutral-300',
};

export function Badge({ tone = 'gray', children }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export const VERDICT_TONE = {
  passed: 'green',
  failed: 'red',
  unmeasurable: 'gray',
  error: 'red',
  aborted: 'amber',
  running: 'amber',
};

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

export const INPUT =
  'rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950';

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded bg-red-600/20 p-2 text-sm text-red-700 dark:text-red-300">
      {error.code ? `${error.code}: ` : ''}
      {error.message}
    </div>
  );
}
