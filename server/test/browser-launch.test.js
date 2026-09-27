import { describe, it, expect, vi } from 'vitest';

const launch = vi.fn(async (opts) => ({
  opts,
  newContext: async () => {
    throw new Error('x');
  },
  close: async () => {},
}));
vi.mock('playwright-core', () => ({ chromium: { launch } }));

describe('browser default launch', () => {
  it('launches headless chromium, honoring CHAOS_CHROMIUM_PATH', async () => {
    const { createBrowserDriver } = await import('../src/drivers/browser.js');
    process.env.CHAOS_CHROMIUM_PATH = '/opt/chromium';
    await expect(createBrowserDriver().open({ url: 'http://f' })).rejects.toThrow('x');
    delete process.env.CHAOS_CHROMIUM_PATH;
    await expect(createBrowserDriver().open({ url: 'http://f' })).rejects.toThrow('x');
    expect(launch.mock.calls.map((c) => c[0])).toEqual([
      { headless: true, executablePath: '/opt/chromium' },
      { headless: true, executablePath: undefined },
    ]);
  });
});
