// tests/state.test.cjs -- state.md read/write (T007 + frontmatter helpers)

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempForgeDir, runTests } = require('./_helper.cjs');
const tools = require('../scripts/forge-tools.cjs');

const { writeState, readState, parseFrontmatter, serializeFrontmatter, formatCavemanValue } = tools;

suite('writeState legacy 3-arg', () => {
  test('writes frontmatter + content from scratch', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'executing', iteration: 5 }, '## Body\n- one\n');
    const state = readState(forgeDir);
    assert.strictEqual(state.data.phase, 'executing');
    assert.strictEqual(state.data.iteration, 5);
    assert.match(state.content, /## Body/);
  });

  test('overwrites existing state with full payload', () => {
    const { forgeDir } = makeTempForgeDir();
    writeState(forgeDir, { phase: 'a', iteration: 1 }, 'A');
    writeState(forgeDir, { phase: 'b', iteration: 2 }, 'B');
    const state = readState(forgeDir);
    assert.strictEqual(state.data.phase, 'b');
    assert.strictEqual(state.data.iteration, 2);
    assert.match(state.content, /B/);
  });
});

suite('writeState partial 2-arg', () => {
  test('merges single field without losing other frontmatter', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'executing', iteration: 3, spec: 'auth' }, 'old body');
    writeState(forgeDir, { iteration: 4 });
    const state = readState(forgeDir);
    assert.strictEqual(state.data.phase, 'executing');
    assert.strictEqual(state.data.iteration, 4);
    assert.strictEqual(state.data.spec, 'auth');
    assert.match(state.content, /old body/);
  });

  test('__content replaces body, leaves frontmatter alone', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'p1' }, 'original body');
    writeState(forgeDir, { __content: 'fresh body\n' });
    const state = readState(forgeDir);
    assert.strictEqual(state.data.phase, 'p1');
    assert.match(state.content, /fresh body/);
    assert.doesNotMatch(state.content, /original/);
  });

  test('__contentAppend appends to body', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'p1' }, 'first\n');
    writeState(forgeDir, { __contentAppend: 'second\n' });
    const state = readState(forgeDir);
    assert.match(state.content, /first/);
    assert.match(state.content, /second/);
  });
});

suite('atomic write hygiene', () => {
  test('no .tmp file left behind after writeState', () => {
    const { forgeDir } = makeTempForgeDir();
    writeState(forgeDir, { phase: 'x' }, 'body');
    const stragglers = fs.readdirSync(forgeDir).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(stragglers, []);
  });
});

suite('parseFrontmatter / serializeFrontmatter', () => {
  test('parses simple types correctly', () => {
    const text = '---\nphase: ready\niteration: 7\nflag: true\n---\n\nbody';
    const r = parseFrontmatter(text);
    assert.strictEqual(r.data.phase, 'ready');
    assert.strictEqual(r.data.iteration, 7);
    assert.strictEqual(r.data.flag, true);
    assert.match(r.content, /body/);
  });

  test('round-trip preserves frontmatter values', () => {
    const data = { phase: 'executing', iteration: 12, spec: 'auth' };
    const content = '## Done\n- T001\n';
    const text = serializeFrontmatter(data, content);
    const parsed = parseFrontmatter(text);
    assert.strictEqual(parsed.data.phase, 'executing');
    assert.strictEqual(parsed.data.iteration, 12);
    assert.strictEqual(parsed.data.spec, 'auth');
    assert.match(parsed.content, /## Done/);
  });

  test('parseFrontmatter on plain text returns empty data', () => {
    const r = parseFrontmatter('just text, no frontmatter');
    assert.deepStrictEqual(r.data, {});
    assert.match(r.content, /just text/);
  });
});

suite('formatCavemanValue (T029, R013)', () => {
  test('drops articles and filler words', () => {
    const out = formatCavemanValue('I just finished the implementation of a new endpoint.');
    assert.doesNotMatch(out, /\bjust\b/);
    assert.doesNotMatch(out, /\bthe\b/);
    assert.doesNotMatch(out, / a /);
    assert.match(out, /finished/);
  });

  test('reduces character count by at least 10%', () => {
    const verbose = 'I just really finished implementing the registration endpoint. Basically, it accepts an email and a password, and it validates them in order to ensure correctness.';
    const caveman = formatCavemanValue(verbose);
    const reduction = 1 - caveman.length / verbose.length;
    assert.ok(reduction >= 0.10, `expected >=10% reduction, got ${(reduction * 100).toFixed(1)}%`);
  });

  test('preserves identifiers and file paths', () => {
    const out = formatCavemanValue('Added writeCheckpoint() to scripts/forge-tools.cjs at line 1610.');
    assert.match(out, /writeCheckpoint\(\)/);
    assert.match(out, /scripts\/forge-tools\.cjs/);
    assert.match(out, /1610/);
  });

  test('skips code fences', () => {
    const input = 'The function works.\n```js\nconst the = a + an;\n```\nThe end.';
    const out = formatCavemanValue(input);
    assert.match(out, /const the = a \+ an;/);
  });

  test('verbose sentinel bypasses transform', () => {
    const verbose = '<!-- verbose -->\nThe user must really read this carefully.';
    const out = formatCavemanValue(verbose);
    assert.strictEqual(out, verbose);
  });

  test('empty and non-string inputs are returned as-is', () => {
    assert.strictEqual(formatCavemanValue(''), '');
    assert.strictEqual(formatCavemanValue(null), null);
    assert.strictEqual(formatCavemanValue(undefined), undefined);
  });

  test('swap rules: in order to -> to, prior to -> before', () => {
    const out = formatCavemanValue('We did this in order to test, prior to release.');
    assert.match(out, / to test/);
    assert.doesNotMatch(out, /in order to/);
    assert.match(out, /before release/);
  });
});

suite('writeState caveman integration', () => {
  test('body content is caveman-formatted by default', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const verbose = 'I just finished implementing the registration endpoint.';
    writeState(forgeDir, { phase: 'executing' }, verbose);
    const state = readState(forgeDir);
    assert.doesNotMatch(state.content, /\bjust\b/);
    assert.doesNotMatch(state.content, /\bthe\b/);
  });

  test('skipCavemanFormat=true preserves verbose body (legacy 3-arg)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    const verbose = 'I just finished implementing the registration endpoint.';
    writeState(forgeDir, { phase: 'executing' }, verbose, { skipCavemanFormat: true });
    const state = readState(forgeDir);
    assert.match(state.content, /just/);
    assert.match(state.content, /the registration/);
  });

  test('__contentAppend is caveman-formatted by default', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'p1' }, 'header\n', { skipCavemanFormat: true });
    writeState(forgeDir, { __contentAppend: 'I really just added a new feature\n' });
    const state = readState(forgeDir);
    assert.doesNotMatch(state.content, /\breally\b/);
    assert.doesNotMatch(state.content, /\bjust\b/);
  });

  test('skipCavemanFormat=true preserves verbose append (2-arg form)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'p1' }, 'header\n', { skipCavemanFormat: true });
    writeState(forgeDir, { __contentAppend: 'I really just added a feature\n' }, { skipCavemanFormat: true });
    const state = readState(forgeDir);
    assert.match(state.content, /really just/);
  });

  test('frontmatter values are never caveman-formatted', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'executing', spec: 'the-auth-spec' }, 'body');
    const state = readState(forgeDir);
    // 'the-auth-spec' is a frontmatter value, must not be touched.
    assert.strictEqual(state.data.spec, 'the-auth-spec');
  });

  test('reader handles verbose legacy state.md (backward compatible)', () => {
    const { forgeDir } = makeTempForgeDir({ seedState: false });
    writeState(forgeDir, { phase: 'p1' }, 'I really just finished the work.', { skipCavemanFormat: true });
    const state = readState(forgeDir);
    assert.match(state.content, /really just finished/);
  });
});

runTests();
