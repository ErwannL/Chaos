import { ROLES } from '../../targets.js';

export default {
  key: 'service_pause',
  kind: 'container',
  title: { fr: 'Pause du service', en: 'Service pause' },
  description: {
    fr: 'Gèle tous les processus du conteneur (docker pause), puis les relance (unpause).',
    en: 'Freezes every process of the container (docker pause), then unpauses it.',
  },
  roles: ROLES,
  requires: [],
  maxDurationS: 300,
  params: {},
  async inject(ctx) {
    const id = await ctx.docker.containerFor(ctx.service.name);
    await ctx.checkpoint({ id });
    await ctx.docker.pause(id);
    return { id };
  },
  async revert(ctx, state) {
    const id = state?.id ?? (await ctx.docker.containerFor(ctx.service.name));
    const st = await ctx.docker.state(id);
    if (st.paused) await ctx.docker.unpause(id);
  },
};
