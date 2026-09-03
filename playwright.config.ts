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
    launchOptions: {
      // Makes the test independent of host multicast-DNS resolution. Without
      // it Chromium emits mDNS-obfuscated <uuid>.local host candidates, and
      // whether those resolve is a property of the machine, not of this code.
      // Measured on this host: Playwright's Chromium resolves them and still
      // connects, while the user's own Chrome.app does NOT (macOS Local
      // Network permission) and the handshake ends in conn:failed. The flag
      // removes that variable so a red test always means a real regression.
      // Chromium is last-switch-wins and Playwright appends our args last, so
      // this REPLACES Playwright's own --disable-features list. Never add a
      // second --disable-features anywhere.
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  // reuseExistingServer is deliberate: the operator keeps `npm run dev` up for
  // the live walkthrough, and there is no CI in this project.
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
