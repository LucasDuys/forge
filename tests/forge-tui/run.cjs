#!/usr/bin/env node
// Zero-dep test runner for forge-tui. Discovers *-test.cjs files in this
// directory, runs each test function, prints one line per test, exits with
// a non-zero code on any failure. No mocha/jest/tap — just assert + require.

'use strict';

const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;

function discoverTestFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('-test.cjs'))
    .sort()
    .map((f) => path.join(TESTS_DIR, f));
}

async function runFile(file) {
  const mod = require(file);
  if (!mod || typeof mod !== 'object') {
    throw new Error(`${path.basename(file)} must export an object of test functions`);
  }
  const results = [];
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    const start = Date.now();
    let err = null;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - start;
    results.push({ name, ms, err });
  }
  return results;
}

(async function main() {
  const files = discoverTestFiles();
  if (files.length === 0) {
    console.log('forge-tui tests: no *-test.cjs files found in', TESTS_DIR);
    process.exit(0);
  }

  let total = 0;
  let failed = 0;
  const allFailures = [];

  for (const file of files) {
    const label = path.basename(file);
    let results;
    try {
      results = await runFile(file);
    } catch (e) {
      console.log(`  [LOAD FAIL] ${label}: ${e.message}`);
      failed++;
      total++;
      allFailures.push({ label, name: '<load>', err: e });
      continue;
    }
    for (const r of results) {
      total++;
      const status = r.err ? 'FAIL' : 'PASS';
      console.log(`  [${status}] ${label} :: ${r.name} (${r.ms}ms)`);
      if (r.err) {
        failed++;
        allFailures.push({ label, name: r.name, err: r.err });
      }
    }
  }

  console.log('');
  console.log(`forge-tui tests: ${total - failed}/${total} passed`);
  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of allFailures) {
      console.log(`  ${f.label} :: ${f.name}`);
      console.log(`    ${f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n    ') : f.err}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
