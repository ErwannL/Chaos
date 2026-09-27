import { browserFault } from './_browser.js';

export default browserFault({
  key: 'browser_missing_chunk',
  title: { fr: 'Chunk JS absent', en: 'Missing JS chunk' },
  description: {
    fr: 'Fait échouer le chargement des chunks JS correspondant au motif (hors entrée).',
    en: 'Fails loading JS chunks matching the pattern (entry excluded).',
  },
  params: {
    chunkPattern: {
      type: 'string',
      regex: true,
      maxLength: 200,
      default: '/assets/(?!index-)[^/]+\\.js$',
    },
  },
  options: (p) => ({ blockPattern: p.chunkPattern }),
});
