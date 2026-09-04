import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // The 5 s default is too short: ICE gathering alone can take seconds.
  expect: { timeout: 20_000 },
  workers: 1, // two RTCPeerConnections per test
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
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
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Needs Google Chrome installed. Without it: npx playwright test --project=chromium
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
  ],
  // reuseExistingServer is deliberate: the operator keeps `npm run dev` up for
  // the live walkthrough. CI does not run this suite -- .github/workflows/deploy-pages.yml
  // gates the Pages deploy on typecheck + build only, so this is a local check.
  // Note what that leaves uncovered: webServer runs `npm run dev`, so every spec here
  // exercises the dev server and nothing exercises the built bundle Pages serves.
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
