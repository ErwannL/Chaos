import { PROXY_ROLES } from './_toxic.js';

const TOXIC = 'chaos_connection_reset';

export default {
  key: 'connection_reset',
  kind: 'network',
  title: { fr: 'Coupure des connexions TCP', en: 'TCP connection reset' },
  description: {
    fr: 'Désactive le proxy (connexions fermées et refusées) ou réinitialise chaque connexion.',
    en: 'Disables the proxy (connections closed and refused) or resets each connection.',
  },
  roles: PROXY_ROLES,
  requires: ['proxy'],
  maxDurationS: 300,
  params: { mode: { type: 'enum', values: ['disable', 'reset_peer'], default: 'disable' } },
  async inject(ctx, params) {
    const proxy = ctx.service.proxy;
    const state = { proxy, mode: params.mode };
    await ctx.checkpoint(state);
    if (params.mode === 'disable') {
      await ctx.toxiproxy.setEnabled(proxy, false);
    } else {
      await ctx.toxiproxy.addToxic(proxy, {
        name: TOXIC,
        type: 'reset_peer',
        stream: 'downstream',
        toxicity: 1,
        attributes: { timeout: 0 },
      });
    }
    return state;
  },
  async revert(ctx, state) {
    const proxy = state?.proxy ?? ctx.service.proxy;
    // Undo both forms: revert must work even with a lost state.
    await ctx.toxiproxy.removeToxic(proxy, TOXIC);
    await ctx.toxiproxy.setEnabled(proxy, true);
  },
};
