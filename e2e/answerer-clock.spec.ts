import { expect, test } from '@playwright/test';

// Measures the claim that licenses NOT building a delivery countdown into the app.
//
// The worry: the answerer starts ICE checks the instant it applies the offer, but a
// human must then copy the answer, switch browsers, paste and click. If that outran
// libwebrtc's 15 s CONNECTION_WRITE_TIMEOUT the handshake would have a hidden
// deadline, and every operator who reads their own logs would deserve to see it.
//
// It does not, and the reason is that the answerer never needed the offerer to APPLY
// the answer -- only to ANSWER its Binding Requests. A check is validated against the
// RECEIVING side's credentials, which the offerer has held since it published the
// offer, so it responds and a peer-reflexive pair forms (RFC 8445 §7.3). This test is
// what turns that from a recalled mechanism into a measured one.

test('the answerer has no delivery deadline: a 20 s late answer still connects', async ({ browser }) => {
  // Chromium only: this is libwebrtc timing, identical across channels, and the
  // stall must outlast 15 s to mean anything -- not worth paying for twice.
  test.skip(test.info().project.name !== 'chromium', 'libwebrtc timing; a deliberate 20 s stall');
  test.setTimeout(120_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await A.goto('/');
  await B.goto('/');

  await A.getByTestId('create-offer').click();
  await expect(A.getByTestId('signal-phase')).toHaveText('offer-ready');

  await B.getByTestId('remote-blob').fill(await A.getByTestId('local-blob').inputValue());
  await B.getByTestId('accept').click();
  await expect(B.getByTestId('signal-phase')).toHaveText('answer-ready');
  const answer = await B.getByTestId('local-blob').inputValue();

  // B is now checking. Hold the answer past the 15 s write-timeout.
  await B.waitForTimeout(20_000);

  // The stall has to be real: if A had already been given the answer the test would
  // pass for the wrong reason.
  await expect(A.getByTestId('wire-log')).not.toContainText('remote answer accepted');
  // And B must have survived it -- neither failed nor put an error on the screen.
  await expect(B.getByTestId('diag')).not.toContainText('ice:failed');
  await expect(B.getByTestId('error')).toHaveText('');

  await A.getByTestId('remote-blob').fill(answer);
  await A.getByTestId('accept').click();

  await expect(A.getByTestId('diag')).toContainText('channel:open');
  await expect(B.getByTestId('diag')).toContainText('channel:open');
  // Nothing diagnosed a failure that never happened.
  await expect(B.getByTestId('wire-log')).not.toContainText('post-mortem');

  await ctxA.close();
  await ctxB.close();
});
