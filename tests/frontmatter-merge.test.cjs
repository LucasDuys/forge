#!/usr/bin/env node
// tests/frontmatter-merge.test.cjs
//
// Regression tests for forge-self-fixes R007: parseFrontmatter must
// collapse multiple leading frontmatter blocks into a single merged data
// object, with later-block values shadowing earlier ones. This makes the
// write/read cycle idempotent when legacy stacked blocks exist in a
// state.md file from a prior buggy setup-state invocation.

'use strict';

const assert = require('node:assert');
const { parseFrontmatter } = require('../scripts/forge-tools.cjs');

function testSingleBlock() {
  const text = [
    '---',
    'phase: executing',
    'spec: demo',
    '---',
    '',
    'body content',
    ''
  ].join('\n');
  const { data, content } = parseFrontmatter(text);
  assert.strictEqual(data.phase, 'executing');
  assert.strictEqual(data.spec, 'demo');
  assert.strictEqual(content.trim(), 'body content');
  console.log('PASS  testSingleBlock');
}

function testStackedBlocksMerge() {
  const text = [
    '---',
    'phase: executing',
    'spec: forge-landing',
    'task_status: pending',
    '---',
    '',
    '---',
    'phase: idle',
    'spec: forge-landing',
    'current_task: null',
    '---',
    '',
    'body after both',
    ''
  ].join('\n');
  const { data, content } = parseFrontmatter(text);
  assert.strictEqual(data.phase, 'idle', 'later phase shadows earlier');
  assert.strictEqual(data.spec, 'forge-landing');
  assert.strictEqual(data.task_status, 'pending', 'only-in-first key preserved');
  assert.strictEqual(data.current_task, null, 'only-in-second key preserved');
  assert.strictEqual(content.trim(), 'body after both');
  console.log('PASS  testStackedBlocksMerge');
}

function testThreeStackedBlocks() {
  const text = [
    '---',
    'a: 1',
    '---',
    '---',
    'a: 2',
    'b: 2',
    '---',
    '---',
    'a: 3',
    'c: 3',
    '---',
    'body',
    ''
  ].join('\n');
  const { data, content } = parseFrontmatter(text);
  assert.strictEqual(data.a, 3, 'latest a wins');
  assert.strictEqual(data.b, 2);
  assert.strictEqual(data.c, 3);
  assert.strictEqual(content.trim(), 'body');
  console.log('PASS  testThreeStackedBlocks');
}

function testNoFrontmatter() {
  const text = 'just body text\nno yaml here\n';
  const { data, content } = parseFrontmatter(text);
  assert.deepStrictEqual(data, {});
  assert.strictEqual(content, text);
  console.log('PASS  testNoFrontmatter');
}

function testHorizontalRuleNotFrontmatter() {
  const text = [
    '---',
    'phase: executing',
    '---',
    '',
    'body with a horizontal rule',
    '',
    '---',
    '',
    'more body'
  ].join('\n');
  const { data, content } = parseFrontmatter(text);
  assert.strictEqual(data.phase, 'executing');
  assert.ok(content.includes('horizontal rule'), 'body preserved');
  assert.ok(content.includes('more body'), 'body after rule preserved');
  console.log('PASS  testHorizontalRuleNotFrontmatter');
}

function run() {
  const tests = [
    testSingleBlock,
    testStackedBlocksMerge,
    testThreeStackedBlocks,
    testNoFrontmatter,
    testHorizontalRuleNotFrontmatter
  ];
  let failed = 0;
  for (const t of tests) {
    try { t(); } catch (err) {
      failed += 1;
      console.error(`FAIL  ${t.name}: ${err.message}`);
      if (err.stack) console.error(err.stack);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
}

run();
