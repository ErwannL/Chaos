import { ROLES } from '../../targets.js';
import { ChaosError } from '../../errors.js';

export default {
  key: 'service_kill',
  kind: 'container',
  title: { fr: 'Arrêt brutal du service', en: 'Service kill' },
  description: {
    fr: 'docker_kill : tue le conteneur (Chaos le relance au revert). process_crash : tue les processus DANS le conteneur ; seule la politique de redémarrage du service peut le relancer.',
    en: 'docker_kill: kills the container (Chaos restarts it on revert). process_crash: kills the processes INSIDE the container; only the service restart policy can bring it back.',
  },
  roles: ROLES,
  requires: [],
  maxDurationS: 300,
  params: {
    method: { type: 'enum', values: ['docker_kill', 'process_crash'], default: 'docker_kill' },
    signal: { type: 'enum', values: ['SIGKILL', 'SIGTERM'], default: 'SIGKILL' },
    restartTimeoutS: { type: 'integer', min: 5, max: 300, default: 60, unit: 's' },
  },
  async inject(ctx, params) {
    const id = await ctx.docker.containerFor(ctx.service.name);
    const state = { id, restartTimeoutS: params.restartTimeoutS };
    await ctx.checkpoint(state);
    if (params.method === 'process_crash') {
      // kill -1 reaches every process but PID 1: with an init (tini), the app
      // dies and the container exits; without one, nothing restarts it.
      const sig = params.signal === 'SIGKILL' ? '-9' : '-15';
      await ctx.docker.exec(id, ['kill', sig, '-1']).catch(() => {});
    } else {
      await ctx.docker.kill(id, params.signal);
    }
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
