import { ROLES } from '../../targets.js';

function isolatedName(project) {
  return `${project}_chaos_isolated`;
}

export default {
  key: 'egress_block',
  kind: 'container',
  title: { fr: 'Blocage de la sortie internet', en: 'Egress block' },
  description: {
    fr: 'Détache le service des réseaux avec passerelle : il ne garde que ses réseaux internes.',
    en: 'Detaches the service from gateway networks: only internal networks remain.',
  },
  roles: ROLES,
  requires: [],
  maxDurationS: 600,
  params: {},
  async inject(ctx) {
    const { docker } = ctx;
    const id = await docker.containerFor(ctx.service.name);
    const nets = await docker.networks(id);
    const disconnected = [];
    let keepsInternal = false;
    for (const [name, ep] of Object.entries(nets)) {
      const info = await docker.networkInfo(name);
      if (info.Internal) keepsInternal = true;
      else disconnected.push({ name, aliases: (ep.Aliases ?? []).filter((a) => a) });
    }
    const isolated = keepsInternal ? null : isolatedName(docker.project);
    const state = { id, disconnected, isolated };
    // Persist the plan BEFORE mutating anything so a crash can be undone.
    await ctx.checkpoint(state);
    if (isolated) {
      await docker.ensureInternalNetwork(isolated);
      await docker.connect(isolated, id, [ctx.service.name]);
    }
    for (const n of disconnected) await docker.disconnect(n.name, id);
    return state;
  },
  async revert(ctx, state) {
    if (!state) return;
    const { docker } = ctx;
    const current = await docker.networks(state.id);
    for (const n of state.disconnected) {
      if (!(n.name in current)) await docker.connect(n.name, state.id, n.aliases);
    }
    if (state.isolated) {
      if (state.isolated in current) await docker.disconnect(state.isolated, state.id);
      await docker.removeNetwork(state.isolated);
    }
  },
};
