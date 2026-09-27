import { toxicFault } from './_toxic.js';

export default toxicFault({
  key: 'latency',
  type: 'latency',
  title: { fr: 'Latence réseau', en: 'Network latency' },
  description: {
    fr: 'Ajoute une latence et une gigue sur un proxy Toxiproxy.',
    en: 'Adds latency and jitter on a Toxiproxy proxy.',
  },
  maxDurationS: 600,
  params: {
    latencyMs: { type: 'integer', min: 0, max: 30_000, default: 1000, unit: 'ms' },
    jitterMs: { type: 'integer', min: 0, max: 10_000, default: 0, unit: 'ms' },
  },
  attributes: (p) => ({ latency: p.latencyMs, jitter: p.jitterMs }),
});
