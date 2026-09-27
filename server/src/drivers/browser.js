/* global document */
const ERROR_SELECTOR = '[role="alert"], [data-chaos-error]';

async function defaultLaunch() {
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    headless: true,
    executablePath: process.env.CHAOS_CHROMIUM_PATH || undefined,
  });
}

function snapshotScript(selector) {
  // Runs in the page: is anything visible, and is an error message shown?
  const text = (document.body?.innerText ?? '').trim();
  const err = document.querySelector(selector);
  return {
    blank: text.length === 0,
    errorShown: !!err && (err.textContent ?? '').trim().length > 0,
    errorText: err ? (err.textContent ?? '').trim().slice(0, 200) : null,
    textSample: text.slice(0, 200),
  };
}

/**
 * Browser-side chaos through Playwright. A session opens the frontend with
 * the requested network conditions; observe() reports what the user sees.
 */
export function createBrowserDriver({ launch = defaultLaunch } = {}) {
  return {
    async open({ url, offline = false, delayPattern, delayMs = 0, blockPattern, loadTimeoutMs }) {
      const browser = await launch();
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        if (delayPattern) {
          const re = new RegExp(delayPattern);
          await page.route(
            (u) => re.test(u.toString()),
            async (route) => {
              await new Promise((r) => setTimeout(r, delayMs));
              await route.continue().catch(() => {});
            },
          );
        }
        if (blockPattern) {
          const re = new RegExp(blockPattern);
          await page.route(
            (u) => re.test(u.toString()),
            (route) => route.abort('failed'),
          );
        }
        await page
          .goto(url, { waitUntil: 'load', timeout: loadTimeoutMs ?? 15_000 })
          .catch(() => {});
        if (offline) await context.setOffline(true);
        return {
          async observe() {
            try {
              return await page.evaluate(snapshotScript, ERROR_SELECTOR);
            } catch (e) {
              return { blank: true, errorShown: false, error: e.message };
            }
          },
          async close() {
            await browser.close();
          },
        };
      } catch (e) {
        await browser.close();
        throw e;
      }
    },
  };
}

export const _test = { snapshotScript, ERROR_SELECTOR };
