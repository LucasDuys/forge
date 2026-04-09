// tests/forge-tui.test.cjs
//
// Wrapper that registers the forge-tui test suite with the project's
// test framework so `node scripts/run-tests.cjs` picks it up. The tests
// themselves live in tests/forge-tui/*-test.cjs and remain runnable
// standalone via `node tests/forge-tui/run.cjs`. Each subdir test file
// exports an object of `{ 'test name': fn }` — we walk those exports and
// register each as a project-style test().
//
// Keeps the fixture (tests/forge-tui/fixture-stream.jsonl) and the
// snapshot baseline (tests/forge-tui/snapshot-render.txt) adjacent to
// the test files that consume them.

const path = require('node:path');
const { suite, test, runTests } = require('./_helper.cjs');

const SUBDIR_TESTS = [
  'parser-test.cjs',
  'reconciler-test.cjs',
  'backoff-test.cjs',
  'fallback-test.cjs',
  'render-test.cjs',
  'v21-integration-test.cjs',
];

for (const file of SUBDIR_TESTS) {
  const mod = require(path.join(__dirname, 'forge-tui', file));
  suite(`forge-tui :: ${file.replace(/-test\.cjs$/, '')}`, () => {
    for (const name of Object.keys(mod)) {
      const fn = mod[name];
      if (typeof fn !== 'function') continue;
      test(name, fn);
    }
  });
}

runTests();
