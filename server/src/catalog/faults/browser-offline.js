import { browserFault } from './_browser.js';

export default browserFault({
  key: 'browser_offline',
  title: { fr: 'Navigateur hors ligne', en: 'Browser offline' },
  description: {
    fr: 'Charge le frontend puis coupe le réseau du navigateur.',
    en: 'Loads the frontend then cuts the browser network.',
  },
  params: {},
  options: () => ({ offline: true }),
});
