/** Shared helpers for Toxiproxy-based faults. */
export const PROXY_ROLES = ['db', 'cache', 'api'];

export function toxicFault({ key, type, attributes, ...rest }) {
  const name = `chaos_${key}`;
  return {
    key,
    kind: 'network',
    roles: PROXY_ROLES,
    requires: ['proxy'],
    ...rest,
    async inject(ctx, params) {
      const proxy = ctx.service.proxy;
      await ctx.checkpoint({ proxy, toxic: name });
      await ctx.toxiproxy.addToxic(proxy, {
        name,
        type,
        stream: 'downstream',
        toxicity: 1,
        attributes: attributes(params),
      });
      return { proxy, toxic: name };
    },
    async revert(ctx, state) {
      await ctx.toxiproxy.removeToxic(state?.proxy ?? ctx.service.proxy, name);
    },
  };
}
