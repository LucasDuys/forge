# Synthetic Smoke Spec (R006.AC5 fixture)

Used by `tests/forge-e2e-smoke.test.cjs` as the input "spec" for the
end-to-end smoke. Two R-numbers, one acceptance criterion each. Kept
deliberately minimal -- the smoke test does NOT execute this spec; it
only references the file path/contents to drive a synthesized run of
the four observable surfaces (wizard, ledger, cache, output-filter,
handoff).

## R001: Echo a string

**Acceptance Criteria:**
- [ ] Module exposes `echo(s)` which returns `s` unchanged.

## R002: Add two integers

**Acceptance Criteria:**
- [ ] Module exposes `add(a, b)` which returns `a + b` for numeric inputs.
