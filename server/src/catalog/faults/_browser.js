/** Shared shape of Playwright-based faults: a browser session is the injection. */
export function browserFault({ key, options, ...rest }) {
  return {
    key,
    kind: 'browser',
    roles: ['frontend'],
    requires: ['frontendUrl'],
    maxDurationS: 300,
    ...rest,
    async inject(ctx, params) {
      const session = await ctx.browser.open({ url: ctx.target.frontendUrl, ...options(params) });
      ctx.attach(session);
      return {};
    },
    async revert(ctx) {
      // Closing the browser removes every browser-side condition.
      await ctx.detach();
    },
  };
}
