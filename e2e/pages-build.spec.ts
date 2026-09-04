import { expect, test } from '@playwright/test';

/**
 * The one check that `npm run build` exiting 0 cannot make: does the built bundle load
 * when it is served under a repo-named subpath, as GitHub Pages serves it?
 *
 * vite.config.ts sets `base: './'`, so index.html emits `./assets/...`. The failure this
 * guards is a ROOT-relative `/assets/...` ref -- introduced by a dynamic import, a
 * `new URL(..., import.meta.url)`, a worker, or a base change -- which resolves outside
 * `/webrtc_chat_demo/` and 404s. The page still renders its static HTML shell when that
 * happens, so "the title is there" proves nothing; only the response codes do.
 *
 * Runs in the `pages-build` project only, against `npm run preview:pages`.
 */
/**
 * Requests the browser makes on its own, which no markup asks for. Measured on this
 * bundle: headless chromium fetches exactly two URLs, the document and the entry chunk,
 * both 200 -- but branded Chrome asks for /favicon.ico unprompted, and both the dev
 * server and `vite preview` 404 it. Nothing here references a favicon, so that 404 is
 * noise, not a regression. Excluded by name rather than by resource type, so a real
 * missing image would still be caught.
 */
const isUnprompted = (url: string): boolean => new URL(url).pathname === '/favicon.ico';

test('the built bundle loads under a Pages subpath with no missing assets', async ({ page }) => {
  const bad: string[] = [];

  // Registered BEFORE goto: a listener attached afterwards misses the document response
  // and every asset the parser has already requested.
  page.on('response', (res) => {
    if (res.status() >= 400 && !isUnprompted(res.url())) bad.push(`${res.status()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    bad.push(`failed (${req.failure()?.errorText ?? 'unknown'}) ${req.url()}`);
  });
  page.on('pageerror', (err) => bad.push(`pageerror: ${err.message}`));

  // './' and not '/'. Playwright resolves a URL against baseURL with `new URL()`, so '/'
  // would resolve to the ORIGIN root and drop /webrtc_chat_demo/ entirely -- the test
  // would 404 for the wrong reason.
  await page.goto('./');

  // Guards the guard: if baseURL ever loses the subpath, the 404 assertion below would
  // pass against the origin root and prove nothing.
  expect(new URL(page.url()).pathname).toBe('/webrtc_chat_demo/');

  // The diagnostics strip is EMPTY in index.html -- render() in src/main.ts is the only
  // thing that ever fills it. So these substrings are evidence the entry chunk resolved,
  // downloaded and executed, which a static-shell assertion (a title, or a button that
  // is already in the HTML) is not.
  await expect(page.getByTestId('diag')).toContainText('sig:stable');
  await expect(page.getByTestId('diag')).toContainText('channel:none');

  expect(bad, 'the built bundle requested something that did not resolve under the subpath').toEqual([]);
});
