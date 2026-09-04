import { expect, test } from '@playwright/test';
import { DEAD_STUN, installPc, SRFLX } from './pc';

// Whether the blob you are about to copy can leave this LAN at all, said BEFORE you
// copy it rather than after the exchange fails.
//
// A description carrying only host candidates is not broken -- on one network it
// connects host<->host, which is the case this repo actually measures. It is simply
// unusable against a peer somewhere else, and nothing said so: the operator learned it
// from a 15 s ICE timeout and a post-mortem, having already delivered the blob by hand.
// So this is a warning next to the Copy button, never an error: LAN-only is a supported
// mode, and handshake.spec.ts asserts a healthy run leaves the error box empty.

test('a blob with no server-reflexive candidate is marked LAN ONLY before it is copied', async ({ page }) => {
  // No ICE servers at all: gathering settles without a STUN round trip to wait on, and
  // host candidates are all there can be. Hermetic -- unlike the real config, this does
  // not depend on stun.l.google.com answering the machine running the suite.
  await installPc(page, { config: { iceServers: [] } });
  await page.goto('/');
  await page.getByTestId('create-offer').click();

  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
  expect(await page.getByTestId('local-blob').inputValue()).not.toMatch(/typ srflx/);

  // Next to the Copy button, where the operator is looking when they decide to copy.
  await expect(page.getByTestId('blob-meta')).toContainText('LAN ONLY');
  await expect(page.getByTestId('wire-log')).toContainText('no server-reflexive candidate');
  // A warning, not a failure: the blob is still worth copying to a peer on this network.
  await expect(page.getByTestId('error')).toHaveText('');
  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
});

test('a blob that does carry a server-reflexive candidate is not marked LAN ONLY', async ({ page }) => {
  // The negative control, and it has to be synthetic: the only other way to get a srflx
  // candidate here is a real STUN round trip, which would make this test a reading of the
  // suite machine's connectivity rather than of the marker.
  await installPc(page, {
    config: { iceServers: [] },
    extraLocalCandidates: [SRFLX('198.51.100.7')],
  });
  await page.goto('/');
  await page.getByTestId('create-offer').click();

  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
  await expect(page.getByTestId('blob-meta')).toContainText('1 srflx');
  await expect(page.getByTestId('blob-meta')).not.toContainText('LAN ONLY');
  await expect(page.getByTestId('wire-log')).not.toContainText('no server-reflexive candidate');
});

test('while gathering is still running the marker says wait, not LAN only', async ({ page }) => {
  // Same zero, different action. Under PARTIAL the candidate may still be seconds away,
  // and "this blob is LAN only" would be a verdict on a set that is not final yet. Only
  // the 3 s timeout is paid here -- not the ~40 s of STUN back-off ice-timeout.spec.ts
  // waits out, because the claim is about what the marker says at that moment.
  await installPc(page, { config: DEAD_STUN });
  await page.goto('/');
  await page.getByTestId('create-offer').click();

  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
  await expect(page.getByTestId('blob-meta')).toContainText('PARTIAL');
  await expect(page.getByTestId('blob-meta')).toContainText('no server-reflexive candidate yet');
  await expect(page.getByTestId('blob-meta')).not.toContainText('LAN ONLY');
});
