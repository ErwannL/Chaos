import { browserFault } from './_browser.js';

export default browserFault({
  key: 'browser_slow_api',
  title: { fr: 'API lente (navigateur)', en: 'Slow API (browser)' },
  description: {
    fr: 'Retarde dans le navigateur les requêtes qui correspondent au motif.',
    en: 'Delays, in the browser, requests matching the pattern.',
  },
  params: {
    delayMs: { type: 'integer', min: 100, max: 60_000, default: 5000, unit: 'ms' },
    urlPattern: { type: 'string', regex: true, maxLength: 200, default: '/api/' },
  },
  options: (p) => ({ delayPattern: p.urlPattern, delayMs: p.delayMs }),
});
