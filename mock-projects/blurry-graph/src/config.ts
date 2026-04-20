// Regression flags for the Forge visual-verifier fixture.
//
// Each flag toggles a deliberate visual bug the verifier must catch.
// `off` is the master kill-switch used for golden-path screenshots:
// when `off` is true, no regression applies regardless of the other flags.
//
// This file is intentionally simple — the fixture's value comes from the
// bugs being easy to spot (both by a Playwright verifier and by a human
// reviewing evidence screenshots), not from a fancy toggle system.
export const regressions = {
  halo: true,
  zoomOut: true,
  synthesis: true,
  off: false
};
