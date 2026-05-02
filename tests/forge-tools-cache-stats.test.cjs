// tests/forge-tools-cache-stats.test.cjs
//
// Unit tests for scripts/forge-tools.cjs::aggregateCacheStats and the
// buildTokensBlock wire-up that surfaces it under tokens.cache (Wave 2 R005).
//
// Coverage:
//   - missing file -> { hits: 0, misses: 0, savings_estimate_tokens: 0 }
//   - mixed hit/miss fixture -> correct counters
//   - savings formula: floor(output_bytes / 4) capped at 4000 per hit
//   - corrupted lines (truncated, garbage, empty) silently skipped
//   - perf: 1000-line log aggregates in <= 2ms
//   - FORGE_TOKEN_OPT=0 -> zeros without reading the file
//   - cross-spec wire-up: buildTokensBlock surfaces aggregator output under tokens.cache
//
// Top-level tests/ per scripts/run-tests.cjs:32 (non-recursive readdir).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const tools = require('../scripts/forge-tools.cjs');
const { aggregateCacheStats, buildTokensBlock } = tools;

function _restoreOpt() {
  if (_origOpt === undefined) delete process.env.FORGE_TOKEN_OPT;
  else process.env.FORGE_TOKEN_OPT = _origOpt;
}

function makeTempForge() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-agg-'));
  const forgeDir = path.join(projectDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  return { projectDir, forgeDir };
}

function writeStats(forgeDir, events) {
  const target = path.join(forgeDir, 'cache-stats.jsonl');
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(target, lines, 'utf8');
}

suite('aggregateCacheStats - basics', () => {
  test('missing file returns all-zero shape', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const out = aggregateCacheStats(forgeDir);
      assert.deepStrictEqual(out, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('empty file returns all-zero shape', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'cache-stats.jsonl'), '', 'utf8');
      const out = aggregateCacheStats(forgeDir);
      assert.deepStrictEqual(out, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns canonical shape (3 keys, all numeric)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { ts: 1, tool: 'Read', pattern_class: 'volatile', hit: true, age_ms: 10, output_bytes: 0 },
      ]);
      const out = aggregateCacheStats(forgeDir);
      assert.deepStrictEqual(Object.keys(out).sort(), ['hits', 'misses', 'savings_estimate_tokens']);
      assert.strictEqual(typeof out.hits, 'number');
      assert.strictEqual(typeof out.misses, 'number');
      assert.strictEqual(typeof out.savings_estimate_tokens, 'number');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('aggregateCacheStats - counters', () => {
  test('5 hits + 3 misses -> hits:5, misses:3', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const events = [];
      for (let i = 0; i < 5; i++) {
        events.push({ ts: Date.now() + i, tool: 'Read', pattern_class: 'volatile', hit: true, age_ms: 5, output_bytes: 0 });
      }
      for (let i = 0; i < 3; i++) {
        events.push({ ts: Date.now() + 100 + i, tool: 'Bash', pattern_class: 'stable', hit: false, age_ms: 0, output_bytes: 0 });
      }
      writeStats(forgeDir, events);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.hits, 5);
      assert.strictEqual(out.misses, 3);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('hit:false counts as miss; truthy hit values count as hit', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: true, output_bytes: 0 },
        { hit: 1, output_bytes: 0 },
        { hit: 'yes', output_bytes: 0 },
        { hit: false, output_bytes: 0 },
        { hit: 0, output_bytes: 0 },
        { hit: null, output_bytes: 0 },
      ]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.hits, 3);
      assert.strictEqual(out.misses, 3);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('aggregateCacheStats - savings formula', () => {
  test('1 hit with output_bytes=8000 -> savings=2000', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [{ hit: true, output_bytes: 8000 }]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.savings_estimate_tokens, 2000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('1 hit with output_bytes=20000 -> savings capped at 4000', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [{ hit: true, output_bytes: 20000 }]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.savings_estimate_tokens, 4000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('multiple hits sum within cap-per-hit', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: true, output_bytes: 4000 },   // 1000
        { hit: true, output_bytes: 12000 },  // 3000
        { hit: true, output_bytes: 50000 },  // 4000 (capped)
      ]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.savings_estimate_tokens, 1000 + 3000 + 4000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('misses contribute zero to savings', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: false, output_bytes: 999999 },
        { hit: false, output_bytes: 999999 },
      ]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.savings_estimate_tokens, 0);
      assert.strictEqual(out.misses, 2);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('hit with missing/non-numeric output_bytes -> 0 savings, still counts as hit', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: true },
        { hit: true, output_bytes: 'lots' },
        { hit: true, output_bytes: -50 },
      ]);
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.hits, 3);
      assert.strictEqual(out.savings_estimate_tokens, 0);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('aggregateCacheStats - resilience', () => {
  test('corrupted lines skipped silently', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const target = path.join(forgeDir, 'cache-stats.jsonl');
      const content = [
        JSON.stringify({ hit: true, output_bytes: 4000 }),
        '{not valid json',
        '',
        'plain text',
        JSON.stringify({ hit: false, output_bytes: 0 }),
        '{"truncated":',
        JSON.stringify({ hit: true, output_bytes: 8000 }),
      ].join('\n');
      fs.writeFileSync(target, content + '\n', 'utf8');
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.hits, 2);
      assert.strictEqual(out.misses, 1);
      assert.strictEqual(out.savings_estimate_tokens, 1000 + 2000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('non-object JSON lines skipped (arrays, primitives)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const target = path.join(forgeDir, 'cache-stats.jsonl');
      const content = [
        JSON.stringify({ hit: true, output_bytes: 4000 }),
        '[]',
        '"string"',
        '42',
        'null',
        JSON.stringify({ hit: false }),
      ].join('\n');
      fs.writeFileSync(target, content + '\n', 'utf8');
      const out = aggregateCacheStats(forgeDir);
      assert.strictEqual(out.hits, 1);
      assert.strictEqual(out.misses, 1);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('does not throw on any malformed input', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const target = path.join(forgeDir, 'cache-stats.jsonl');
      fs.writeFileSync(target, '\x00\x01\x02 binary garbage \xff\xfe\n', 'utf8');
      assert.doesNotThrow(() => aggregateCacheStats(forgeDir));
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('aggregateCacheStats - perf', () => {
  test('1000-line log aggregates in <= 5ms (target 2ms, slop for CI noise)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const events = [];
      for (let i = 0; i < 1000; i++) {
        events.push({
          ts: Date.now() + i,
          tool: i % 2 === 0 ? 'Read' : 'Bash',
          pattern_class: 'volatile',
          hit: i % 3 !== 0,
          age_ms: i,
          output_bytes: 1000 + (i * 10),
        });
      }
      writeStats(forgeDir, events);
      const t0 = process.hrtime.bigint();
      const out = aggregateCacheStats(forgeDir);
      const t1 = process.hrtime.bigint();
      const elapsed_ms = Number(t1 - t0) / 1e6;
      assert.ok(elapsed_ms <= 5, `aggregator took ${elapsed_ms.toFixed(2)}ms on 1000 lines (budget 5ms)`);
      assert.ok(out.hits + out.misses === 1000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('aggregateCacheStats - FORGE_TOKEN_OPT kill switch', () => {
  test('FORGE_TOKEN_OPT=0 returns zeros without reading file', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: true, output_bytes: 8000 },
        { hit: true, output_bytes: 8000 },
      ]);
      process.env.FORGE_TOKEN_OPT = '0';
      try {
        const out = aggregateCacheStats(forgeDir);
        assert.deepStrictEqual(out, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
      } finally {
        _restoreOpt();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

suite('buildTokensBlock cross-spec wire-up', () => {
  test('tokens.cache reflects aggregator output (Wave 1 R004 contract)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [
        { hit: true, output_bytes: 4000 },   //  1000
        { hit: true, output_bytes: 12000 },  //  3000
        { hit: false, output_bytes: 0 },
        { hit: false, output_bytes: 0 },
      ]);
      const block = buildTokensBlock(forgeDir);
      assert.strictEqual(block.cache.hits, 2);
      assert.strictEqual(block.cache.misses, 2);
      assert.strictEqual(block.cache.savings_estimate_tokens, 4000);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('tokens.cache zero-fills when log missing (no regression for v1 ledgers)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      const block = buildTokensBlock(forgeDir);
      assert.deepStrictEqual(block.cache, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('tokens.cache zero-fills under FORGE_TOKEN_OPT=0 even with non-empty log', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [{ hit: true, output_bytes: 8000 }]);
      process.env.FORGE_TOKEN_OPT = '0';
      try {
        const block = buildTokensBlock(forgeDir);
        assert.deepStrictEqual(block.cache, { hits: 0, misses: 0, savings_estimate_tokens: 0 });
      } finally {
        _restoreOpt();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('tokens.cache field shape preserved (3 keys, exactly as Wave 1 R004 specifies)', () => {
    const { projectDir, forgeDir } = makeTempForge();
    try {
      writeStats(forgeDir, [{ hit: true, output_bytes: 4000 }]);
      const block = buildTokensBlock(forgeDir);
      assert.deepStrictEqual(Object.keys(block.cache).sort(), ['hits', 'misses', 'savings_estimate_tokens']);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

runTests();
