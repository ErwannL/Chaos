/** Self-contained HTML export of a run report (no external assets). */
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const T = {
  fr: {
    title: 'Rapport Chaos',
    target: 'Cible',
    status: 'Statut',
    score: 'Score de résilience',
    actor: 'Lancé par',
    steps: 'Étapes',
    expectations: 'Attentes',
    evidence: 'Preuves',
    errors: 'Erreurs',
    timeline: 'Sondes',
    passed: 'passé',
    failed: 'échoué',
    unmeasurable: 'non mesurable',
    revert: 'revert',
  },
  en: {
    title: 'Chaos report',
    target: 'Target',
    status: 'Status',
    score: 'Resilience score',
    actor: 'Started by',
    steps: 'Steps',
    expectations: 'Expectations',
    evidence: 'Evidence',
    errors: 'Errors',
    timeline: 'Probes',
    passed: 'passed',
    failed: 'failed',
    unmeasurable: 'unmeasurable',
    revert: 'revert',
  },
};

const COLORS = { passed: '#22c55e', failed: '#ef4444', unmeasurable: '#a3a3a3' };

function timeline(report) {
  const W = 900;
  const t0 = report.startedAtMs;
  const t1 = Math.max(t0 + 1, ...report.samples.map((s) => s.ts));
  const x = (ts) => ((ts - t0) / (t1 - t0)) * W;
  const probes = [...new Set(report.samples.filter((s) => 'status' in s).map((s) => s.probe))];
  const rowH = 22;
  const H = probes.length * rowH + 10;
  const bands = report.windows
    .map(
      (w) =>
        `<rect x="${x(w.start)}" y="0" width="${Math.max(2, x(w.end ?? t1) - x(w.start))}" height="${H}" fill="#f59e0b33"><title>${esc(w.fault)} → ${esc(w.service)}</title></rect>`,
    )
    .join('');
  const rows = probes
    .map((p, i) => {
      const dots = report.samples
        .filter((s) => s.probe === p)
        .map((s) => {
          const ok = s.status !== null && s.status < 500;
          return `<rect x="${x(s.ts)}" y="${i * rowH + 4}" width="4" height="14" fill="${ok ? '#22c55e' : '#ef4444'}"><title>${esc(new Date(s.ts).toISOString())} ${esc(s.status ?? s.error)}</title></rect>`;
        })
        .join('');
      return `<text x="-6" y="${i * rowH + 16}" text-anchor="end" fill="#a3a3a3" font-size="11">${esc(p)}</text>${dots}`;
    })
    .join('');
  return `<svg viewBox="-140 0 ${W + 150} ${H}" width="100%" role="img">${bands}${rows}</svg>`;
}

export function renderReportHtml(report, lang = 'fr') {
  const t = T[lang] ?? T.fr;
  const exps = report.expectations
    .map(
      (
        e,
      ) => `<tr><td><span class="pill" style="background:${COLORS[e.verdict]}">${esc(t[e.verdict])}</span></td>
<td><code>${esc(e.type)}</code> ${esc(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['type', 'verdict', 'message', 'evidence'].includes(k)))))}</td>
<td>${esc(e.message)}<details><summary>${esc(t.evidence)} (${e.evidence.length})</summary><pre>${esc(e.evidence.map((s) => JSON.stringify(s)).join('\n'))}</pre></details></td></tr>`,
    )
    .join('');
  const steps = report.steps
    .map(
      (s) =>
        `<li><code>${esc(s.fault)}</code> → ${esc(s.service)} (${esc(s.durationS)} s) ${esc(JSON.stringify(s.params))} — ${esc(t.revert)}: ${s.revertOk ? 'OK' : 'KO'}${s.error ? ` — ${esc(s.error)}` : ''}</li>`,
    )
    .join('');
  const errors = report.errors.length
    ? `<h2>${esc(t.errors)}</h2><ul>${report.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'fr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} — ${esc(report.scenario.name)}</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;margin:0;padding:24px;max-width:1100px}
h1{margin-top:0}table{border-collapse:collapse;width:100%}td{border-top:1px solid #262626;padding:8px;vertical-align:top}
.pill{color:#0a0a0a;border-radius:999px;padding:2px 10px;font-weight:600;white-space:nowrap}
pre{white-space:pre-wrap;font-size:11px;color:#a3a3a3}.meta{color:#a3a3a3}.score{font-size:40px;font-weight:700}
</style></head><body>
<h1>${esc(t.title)} — ${esc(report.scenario.name)}</h1>
<p class="meta">${esc(t.target)}: ${esc(report.target)} (${esc(report.environment)}) · ${esc(t.status)}: <strong>${esc(report.status)}</strong> · ${esc(t.actor)}: ${esc(report.actor)} · ${esc(report.startedAt)} → ${esc(report.endedAt)}</p>
<p>${esc(t.score)}: <span class="score">${report.score === null ? '—' : `${report.score}/100`}</span></p>
<h2>${esc(t.timeline)}</h2>${timeline(report)}
<h2>${esc(t.steps)}</h2><ul>${steps}</ul>
<h2>${esc(t.expectations)}</h2><table>${exps}</table>
${errors}
</body></html>`;
}
