/**
 * Probe timeline: one row per probe, a mark per sample (green < 500, red
 * otherwise or no answer), fault windows shaded.
 */
export default function ProbeChart({ samples, windows, now }) {
  if (!samples.length) return null;
  const W = 800;
  const t0 = samples[0].ts;
  const t1 = Math.max(now ?? 0, ...samples.map((s) => s.ts), t0 + 1);
  const x = (ts) => ((ts - t0) / (t1 - t0)) * W;
  const probes = [
    ...new Set(
      samples.filter((s) => 'status' in s || 'running' in s || 'blank' in s).map((s) => s.probe),
    ),
  ];
  const row = 22;
  const ok = (s) =>
    'blank' in s
      ? !s.blank
      : 'running' in s
        ? s.running && !s.paused
        : s.status !== null && s.status < 500;
  return (
    <svg
      viewBox={`-150 0 ${W + 160} ${probes.length * row + 8}`}
      className="w-full"
      role="img"
      aria-label="probes"
    >
      {windows.map((w, i) => (
        <rect
          key={i}
          x={x(w.start)}
          y={0}
          width={Math.max(2, x(w.end ?? t1) - x(w.start))}
          height={probes.length * row + 8}
          className="fill-amber-500/20"
        >
          <title>{w.fault}</title>
        </rect>
      ))}
      {probes.map((p, i) => (
        <g key={p}>
          <text x={-8} y={i * row + 16} textAnchor="end" className="fill-neutral-500 text-[11px]">
            {p}
          </text>
          {samples
            .filter((s) => s.probe === p)
            .map((s, j) => (
              <rect
                key={j}
                x={x(s.ts)}
                y={i * row + 4}
                width={4}
                height={14}
                className={ok(s) ? 'fill-green-500' : 'fill-red-500'}
              >
                <title>{`${new Date(s.ts).toISOString()} ${s.status ?? s.error ?? ''}`}</title>
              </rect>
            ))}
        </g>
      ))}
    </svg>
  );
}
