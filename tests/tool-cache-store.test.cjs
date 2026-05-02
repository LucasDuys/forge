// tests/tool-cache-store.test.cjs
//
// Unit tests for hooks/tool-cache-store.js::recordCacheEvent (Wave 2 R005.AC1).
//
// Coverage:
//   - happy path: appends a valid JSON line to .forge/cache-stats.jsonl
//   - multiple appends: file ends up with N lines
//   - compaction: writes >1100 lines triggers trim to last 1000
//   - FORGE_TOKEN_OPT=0 guard: writer no-ops, file unchanged
//   - missing forgeDir: writer creates the directory, doesn't throw
//   - field coercion: hit=truthy -> bool, output_bytes/age_ms -> number, etc.
//   - write failure: returns { written: false, error }, doesn't throw
//
// Note on file location:
//   Top-level tests/ per scripts/run-tests.cjs:32 (non-recursive readdir).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');

// Clear any inherited FORGE_TOKEN_OPT before requiring the module.
const _origOpt = process.env.FORGE_TOKEN_OPT;
delete process.env.FORGE_TOKEN_OPT;

const store = require('../hooks/tool-cache-store.js');
const { recordCacheEvent, CACHE_STATS_TARGET_LINES, CACHE_STATS_COMPACT_THRESHOLD } = store;

function _restoreOpt() {
  if (_origOpt === undefined) {
    delete process.env.FORGE_TOKEN_OPT;
  } else {
    process.env.FORGE_TOKEN_OPT = _origOpt;
  }
}

function makeTempForge() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-store-'));
  const forgeDir = path.join(projectDir, '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  return { projectDir, forgeDir };
}

function readLines(forgeDir) {
  const target = path.join(forgeDir, 'cache-stats.jsonl');
  if (!fs.existsSync(target)) return [];
  const buf = fs.readFileSync(target, 'utf8');
  const arr = buf.split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

suite('recordCacheEvent — happy path', () => {
  test('appends a single valid JSON line with all required fields', () => {
    const { forgeDir } = makeTempForge();
    const result = recordCacheEvent(
      { tool: 'Bash', pattern_class: 'git-status', hit: true, age_ms: 1500, output_bytes: 800 },
      { forgeDir }
    );
    assert.strictEqual(result.written, true);
    assert.strictEqual(result.compacted, false);

    const lines = readLines(forgeDir);
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.ok(typeof parsed.ts === 'number' && parsed.ts > 0, 'ts is set');
    assert.strictEqual(parsed.tool, 'Bash');
    assert.strictEqual(parsed.pattern_class, 'git-status');
    assert.strictEqual(parsed.hit, true);
    assert.strictEqual(parsed.age_ms, 1500);
    assert.strictEqual(parsed.output_bytes, 800);
  });

  test('three sequential appends produce three lines', () => {
    const { forgeDir } = makeTempForge();
    recordCacheEvent({ tool: 'Bash', pattern_class: 'a', hit: true,  age_ms: 1, output_bytes: 100 }, { forgeDir });
    recordCacheEvent({ tool: 'Bash', pattern_class: 'b', hit: false, age_ms: 2, output_bytes: 200 }, { forgeDir });
    recordCacheEvent({ tool: 'Grep', pattern_class: 'c', hit: true,  age_ms: 3, output_bytes: 300 }, { forgeDir });

    const lines = readLines(forgeDir);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(JSON.parse(lines[0]).pattern_class, 'a');
    assert.strictEqual(JSON.parse(lines[1]).pattern_class, 'b');
    assert.strictEqual(JSON.parse(lines[2]).pattern_class, 'c');
  });
});

suite('recordCacheEvent — field coercion', () => {
  test('hit is coerced to bool; numbers default to 0', () => {
    const { forgeDir } = makeTempForge();
    recordCacheEvent(
      { tool: 'Read', pattern_class: 'x', hit: 1, age_ms: 'oops', output_bytes: undefined },
      { forgeDir }
    );
    const lines = readLines(forgeDir);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.hit, true, 'truthy non-bool coerces to true');
    assert.strictEqual(parsed.age_ms, 0, 'non-numeric age_ms defaults to 0');
    assert.strictEqual(parsed.output_bytes, 0, 'undefined output_bytes defaults to 0');
  });

  test('missing event fields produce safe defaults, no throw', () => {
    const { forgeDir } = makeTempForge();
    const result = recordCacheEvent({}, { forgeDir });
    assert.strictEqual(result.written, true);
    const parsed = JSON.parse(readLines(forgeDir)[0]);
    assert.strictEqual(parsed.tool, '');
    assert.strictEqual(parsed.pattern_class, '');
    assert.strictEqual(parsed.hit, false);
  });
});

suite('recordCacheEvent — compaction', () => {
  test('passing the compaction threshold trims to the target line count', () => {
    const { forgeDir } = makeTempForge();
    const target = path.join(forgeDir, 'cache-stats.jsonl');
    // Pre-seed a file with exactly CACHE_STATS_COMPACT_THRESHOLD lines, all
    // valid JSON, so that the next append pushes us to threshold + 1, which
    // triggers compaction down to CACHE_STATS_TARGET_LINES.
    const seedLines = [];
    for (let i = 0; i < CACHE_STATS_COMPACT_THRESHOLD; i++) {
      seedLines.push(JSON.stringify({
        ts: 1000 + i, tool: 'Bash', pattern_class: 'seed', hit: false, age_ms: 0, output_bytes: 0
      }));
    }
    fs.writeFileSync(target, seedLines.join('\n') + '\n');

    const before = readLines(forgeDir);
    assert.strictEqual(before.length, CACHE_STATS_COMPACT_THRESHOLD);

    const result = recordCacheEvent(
      { tool: 'Bash', pattern_class: 'last', hit: true, age_ms: 99, output_bytes: 999 },
      { forgeDir }
    );
    assert.strictEqual(result.written, true);
    assert.strictEqual(result.compacted, true, 'should have compacted');

    const after = readLines(forgeDir);
    assert.strictEqual(after.length, CACHE_STATS_TARGET_LINES, 'should trim to target lines');
    // Last line should be our most recent append.
    const lastParsed = JSON.parse(after[after.length - 1]);
    assert.strictEqual(lastParsed.pattern_class, 'last');
    assert.strictEqual(lastParsed.output_bytes, 999);
  });

  test('below threshold: no compaction, file grows by exactly one line', () => {
    const { forgeDir } = makeTempForge();
    for (let i = 0; i < 10; i++) {
      recordCacheEvent({ tool: 'Bash', pattern_class: 'p', hit: false, age_ms: 0, output_bytes: 0 }, { forgeDir });
    }
    assert.strictEqual(readLines(forgeDir).length, 10);
    const result = recordCacheEvent({ tool: 'Bash', pattern_class: 'p', hit: false, age_ms: 0, output_bytes: 0 }, { forgeDir });
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(readLines(forgeDir).length, 11);
  });
});

suite('recordCacheEvent — FORGE_TOKEN_OPT=0 kill switch', () => {
  test('returns disabled, leaves filesystem untouched', () => {
    const { forgeDir } = makeTempForge();
    const target = path.join(forgeDir, 'cache-stats.jsonl');
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      const result = recordCacheEvent(
        { tool: 'Bash', pattern_class: 'x', hit: true, age_ms: 1, output_bytes: 1 },
        { forgeDir }
      );
      assert.strictEqual(result.written, false);
      assert.strictEqual(result.disabled, true);
      assert.strictEqual(fs.existsSync(target), false, 'file should not be created');
    } finally {
      _restoreOpt();
    }
  });
});

suite('recordCacheEvent — defensive', () => {
  test('missing forgeDir parent is auto-created', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-store-nodir-'));
    // Note: do NOT mkdir .forge — let recordCacheEvent create it.
    const forgeDir = path.join(projectDir, '.forge');
    assert.strictEqual(fs.existsSync(forgeDir), false);
    const result = recordCacheEvent(
      { tool: 'Bash', pattern_class: 'x', hit: false, age_ms: 0, output_bytes: 0 },
      { forgeDir }
    );
    assert.strictEqual(result.written, true);
    assert.strictEqual(fs.existsSync(forgeDir), true);
    assert.strictEqual(readLines(forgeDir).length, 1);
  });

  test('write failure returns { written: false, error }, never throws', () => {
    // Force a write failure by monkey-patching fs.appendFileSync to throw,
    // then restoring it. Tests must restore even on assertion failure.
    const orig = fs.appendFileSync;
    fs.appendFileSync = function () { throw new Error('mock-readonly-fs'); };
    let result;
    try {
      assert.doesNotThrow(() => {
        result = recordCacheEvent(
          { tool: 'Bash', pattern_class: 'x', hit: false, age_ms: 0, output_bytes: 0 },
          { forgeDir: os.tmpdir() }
        );
      }, 'should never throw');
      assert.strictEqual(result.written, false);
      assert.ok(typeof result.error === 'string' && result.error.length > 0);
    } finally {
      fs.appendFileSync = orig;
    }
  });
});

runTests();
