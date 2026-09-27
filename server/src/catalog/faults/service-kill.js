import { ROLES } from '../../targets.js';
import { ChaosError } from '../../errors.js';

export default {
  key: 'service_kill',
  kind: 'container',
  title: { fr: 'Arrêt brutal du service', en: 'Service kill' },
  description: {
    fr: 'Tue le conteneur, puis vérifie qu’il redémarre (le relance si besoin).',
    en: 'Kills the container, then checks it restarts (starting it if needed).',
  },
  roles: ROLES,
  requires: [],
  maxDurationS: 300,
  params: {
    signal: { type: 'enum', values: ['SIGKILL', 'SIGTERM'], default: 'SIGKILL' },
    restartTimeoutS: { type: 'integer', min: 5, max: 300, default: 60, unit: 's' },
  },
  async inject(ctx, params) {
    const id = await ctx.docker.containerFor(ctx.service.name);
    const state = { id, restartTimeoutS: params.restartTimeoutS };
    await ctx.checkpoint(state);
    await ctx.docker.kill(id, params.signal);
    return state;
  },
  async revert(ctx, state) {
    const id = state?.id ?? (await ctx.docker.containerFor(ctx.service.name));
    const timeoutMs = (state?.restartTimeoutS ?? 60) * 1000;
    const deadline = ctx.clock.now() + timeoutMs;
    let st = await ctx.docker.state(id);
    if (!st.running) await ctx.docker.start(id);
    for (;;) {
      st = await ctx.docker.state(id);
      if (st.running && st.health !== 'starting' && st.health !== 'unhealthy') return;
      if (ctx.clock.now() >= deadline) {
        throw new ChaosError('RESTART_FAILED', `${ctx.service.name} did not restart in time`, 500);
      }
      await ctx.clock.sleep(500);
    }
  },
};
