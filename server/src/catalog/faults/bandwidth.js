import { toxicFault } from './_toxic.js';

export default toxicFault({
  key: 'bandwidth',
  type: 'bandwidth',
  title: { fr: 'Débit limité', en: 'Bandwidth limit' },
  description: {
    fr: 'Limite le débit descendant d’un proxy Toxiproxy.',
    en: 'Limits downstream throughput of a Toxiproxy proxy.',
  },
  maxDurationS: 600,
  params: { rateKBps: { type: 'integer', min: 1, max: 1_000_000, default: 10, unit: 'KB/s' } },
  attributes: (p) => ({ rate: p.rateKBps }),
});
