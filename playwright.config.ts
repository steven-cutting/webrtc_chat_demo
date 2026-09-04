import { defineConfig } from '@playwright/test';

/** Everything the dev-server projects share. The subpath project overrides baseURL. */
const DEV_URL = 'http://127.0.0.1:5173';
/** The preview server mimics the Pages layout: a project page under a repo-named path. */
const PAGES_URL = 'http://127.0.0.1:4173/webrtc_chat_demo/';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // The 5 s default is too short: ICE gathering alone can take seconds.
  expect: { timeout: 20_000 },
  workers: 1, // two RTCPeerConnections per test
  retries: 0,
  use: {
    baseURL: DEV_URL,
    // NOT 'on-first-retry': with retries: 0 that would never fire.
    trace: 'retain-on-failure',
  },
  // Stock launch args, deliberately. An earlier revision passed
  // --disable-features=WebRtcHideLocalIpsWithMdns to strip mDNS obfuscation off
  // host candidates. It is gone for two measured reasons:
  //   1. Chromium is last-switch-wins on --disable-features and Playwright
  //      pushes config args AFTER its own switches, so that one bare flag
  //      REPLACED Playwright's 16-entry disable list -- silently re-enabling
  //      PaintHolding, AvoidUnnecessaryBeforeUnloadCheckSync and the rest, the
  //      very features Playwright disables to keep automation from hanging.
  //      (playwright-core 1.62.1 coreBundle.js:34605-34658, then :43093.)
  //   2. It defended a hazard that does not reproduce. With obfuscation left
  //      ON, the full handshake reaches channel:open in ~280 ms in BOTH bundled
  //      Chromium and Google Chrome on this host, and mDNS emission is identical
  //      in the two builds -- there is no Chromium-vs-Chrome.app asymmetry here.
  // So the suite now runs the browser the operator actually uses, unmodified,
  // and mDNS is a variable under test rather than one configured away.
  projects: [
    { name: 'chromium', testIgnore: /pages-build\.spec\.ts/, use: { browserName: 'chromium' } },
    // Needs Google Chrome installed. Without it: npx playwright test --project=chromium
    { name: 'chrome', testIgnore: /pages-build\.spec\.ts/, use: { browserName: 'chromium', channel: 'chrome' } },
    // The only project that tests what Pages actually serves: the BUILT bundle, under a
    // repo-named subpath. It runs the 404 guard plus the real handshake -- the two things
    // `npm run build` succeeding cannot tell you. This is the project CI runs.
    {
      name: 'pages-build',
      testMatch: [/handshake\.spec\.ts/, /pages-build\.spec\.ts/],
      use: { browserName: 'chromium', baseURL: PAGES_URL },
    },
  ],
  // reuseExistingServer on the dev server is deliberate: the operator keeps `npm run dev`
  // up for the live walkthrough.
  //
  // CI runs `--project=pages-build` (.github/workflows/deploy-pages.yml), so part of this
  // suite IS a CI gate now. Everything else stays local: the chromium-only specs --
  // ice-timeout, post-mortem, answerer-clock, ~1 min 45 s of deliberate waits -- and
  // routable-blob and ice-config, which are fast but make no claim about the built bundle.
  //
  // Both servers start on every run, because Playwright starts every webServer entry
  // regardless of --project. So `npm run test:e2e` now also pays one `vite build`.
  webServer: [
    {
      command: 'npm run dev',
      url: DEV_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // Builds first, so the preview can never serve a stale dist/. reuseExistingServer is
      // false for the same reason -- a leftover preview would serve the previous bundle
      // and pass. With --strictPort a collision is loud rather than silently reused.
      // The script also passes --host 127.0.0.1: measured, `vite preview` binds [::1] ONLY
      // by default, so this URL times out without it.
      command: 'npm run preview:pages',
      url: PAGES_URL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
