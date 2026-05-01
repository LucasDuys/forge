// tests/forge-hands-off-verify.test.cjs -- Wave 3 T005 / R003 + R004 (token-output-effort)
//
// Hands-off + wizard-wiring verification for the token-output-effort spec.
//
// Covers:
//   - R003.AC3: agents/forge-*.md were NOT modified by this spec's commits
//   - R003.AC4: skills/*/SKILL.md and CLAUDE.md were NOT modified by this spec's commits
//   - R004.AC3: commands/{brainstorm,plan,execute,status}.md each invoke
//                scripts/forge-wizard.cjs at the start of execution
//   - R004.AC5: kill-switch path through the wizard module
//   - R004.AC6: TUI active suppresses the wizard (no double-render)
//
// The "spec range" for the diff assertions is detected at runtime by walking
// `git log --grep` for the commit subject prefix that this spec uses
// ("token-output-effort"). The boundary is the parent of the first such
// commit. If no spec commits exist on the current branch (e.g. running on
// main pre-merge) the diff assertions are auto-skipped.
//
// If git is not available on PATH, the diff tests report SKIPPED (not
// FAILED) by passing trivially with a warning to stdout. The non-git tests
// (call-site parsing, wizard-module behavior) still run.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  suite, test, assert, makeTempForgeDir, gitAvailable, runTests
} = require('./_helper.cjs');

// Default code path: kill switch off unless a test sets it.
delete process.env.FORGE_TOKEN_OPT;

const REPO_ROOT = path.resolve(__dirname, '..');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const WIZARD_PATH = path.resolve(REPO_ROOT, 'scripts', 'forge-wizard.cjs');

// Subject prefix used by the token-output-effort spec's commits, e.g.
// "feat(token-output-effort): T001 — generalized output filter".
const SPEC_COMMIT_GREP = 'token-output-effort';

// --- helpers -------------------------------------------------------------

function _git(args, opts) {
  // Wrap git so command failures surface as diagnostic messages instead of
  // EPIPE/ENOENT stack traces. Returns trimmed stdout on success, null on
  // failure (caller decides whether that is fatal).
  try {
    const out = execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: (opts && opts.timeout) || 5000
    });
    return out.trim();
  } catch (e) {
    return null;
  }
}

function _isGitRepo() {
  return _git(['rev-parse', '--git-dir']) !== null;
}

function _findSpecCommitRange() {
  // Returns { base, head } such that `git diff base..head` covers exactly
  // the commits whose subject contains SPEC_COMMIT_GREP. Returns null if
  // no such commits are present (e.g. on main, pre-merge).
  //
  // Strategy: list spec commits oldest-first; the first one's parent is
  // the base, HEAD is the upper bound. This intentionally excludes
  // unrelated commits that happen to live between spec commits, by
  // diffing only against the parent of the first spec commit -- but the
  // subsequent spec commits are guaranteed to be on the same branch
  // tip, so the diff range is contiguous. (If unrelated commits are
  // interleaved between spec commits, they would also show up in the
  // diff -- but the spec's invariant is "this spec did not touch X",
  // and an interleaved unrelated commit touching X is, by definition,
  // not a violation of the spec. The test therefore filters the diff
  // by the spec's commit list rather than using a single range.)
  const oldestFirst = _git([
    'log', '--reverse', '--format=%H', `--grep=${SPEC_COMMIT_GREP}`
  ]);
  if (!oldestFirst) return null;
  const commits = oldestFirst.split('\n').filter(Boolean);
  if (commits.length === 0) return null;
  return { commits };
}

function _filesTouchedByCommits(commits, pathspec) {
  // Returns the set of files inside `pathspec` (relative or glob, e.g.
  // `agents/`) that were modified, added, or deleted by ANY commit in
  // `commits`. This is the precise definition of "this spec's commits
  // touched these files" -- it ignores other commits on the branch.
  const touched = new Set();
  for (const sha of commits) {
    // git show --name-only --format= -- <pathspec>
    const out = _git([
      'show', '--name-only', '--format=', sha, '--', ...pathspec
    ]);
    if (!out) continue;
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p) touched.add(p);
    }
  }
  return Array.from(touched).sort();
}

function _readCommandFile(name) {
  return fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
}

function _hasWizardInvocation(body) {
  // Match the canonical single-line invocation. We accept either single or
  // double quotes around the script path, and tolerate ${CLAUDE_PLUGIN_ROOT}
  // expansion. The match also requires --forge-dir to be present so that a
  // bare "node forge-wizard.cjs" reference in prose doesn't false-positive.
  const re = /node\s+["']?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/forge-wizard\.cjs["']?[^\n]*--forge-dir/;
  return re.test(body);
}

function _wizardCallSitePosition(body) {
  // Returns the byte offset of the FIRST wizard invocation in the file, or
  // -1 if absent. Used to assert the call-site lives at the start of
  // execution (before any other Bash invocation that does real work).
  const m = body.match(/node\s+["']?\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/forge-wizard\.cjs/);
  return m ? m.index : -1;
}

function _firstSubstantiveBashAfterFrontmatter(body) {
  // Heuristic: find the first bash code fence after the YAML frontmatter.
  // The wizard invocation must come at or before this position. We don't
  // want it shoved into a "Step 7" buried under pre-flight checks.
  // The frontmatter is the first --- ... --- block at the top of the file.
  // CRLF-tolerant: match \r?\n on Windows checkouts.
  const fmRe = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
  const fmMatch = body.match(fmRe);
  const start = fmMatch ? fmMatch[0].length : 0;
  const m = body.slice(start).match(/```bash\r?\n/);
  return m ? start + m.index : -1;
}

// --- 1. Hands-off verification (R003.AC3, R003.AC4) ------------------------

suite('hands-off: spec did not modify agents/skills/CLAUDE.md', () => {
  test('git is available and we are in a repo (precondition)', () => {
    if (!gitAvailable()) {
      process.stdout.write(
        'SKIP hands-off git diff tests: git not on PATH\n'
      );
      return;
    }
    if (!_isGitRepo()) {
      process.stdout.write(
        'SKIP hands-off git diff tests: not a git repo\n'
      );
      return;
    }
    // No assertion -- this test is a precondition probe. The actual
    // verification happens in the next two tests, which silently no-op
    // when git is unavailable.
  });

  test('R003.AC3: spec commits did not touch agents/forge-*.md', () => {
    if (!gitAvailable() || !_isGitRepo()) {
      process.stdout.write('  (skipped, no git)\n');
      return;
    }
    const range = _findSpecCommitRange();
    if (!range) {
      // No spec commits on this branch yet -- vacuous truth.
      process.stdout.write(
        '  (skipped, no token-output-effort commits found)\n'
      );
      return;
    }
    const touched = _filesTouchedByCommits(range.commits, ['agents/']);
    assert.deepStrictEqual(
      touched, [],
      `R003.AC3 violation: spec commits modified agent files: ${JSON.stringify(touched)}`
    );
  });

  test('R003.AC4: spec commits did not touch skills/*/SKILL.md or CLAUDE.md', () => {
    if (!gitAvailable() || !_isGitRepo()) {
      process.stdout.write('  (skipped, no git)\n');
      return;
    }
    const range = _findSpecCommitRange();
    if (!range) {
      process.stdout.write(
        '  (skipped, no token-output-effort commits found)\n'
      );
      return;
    }
    const touched = _filesTouchedByCommits(range.commits, ['skills/', 'CLAUDE.md']);
    assert.deepStrictEqual(
      touched, [],
      `R003.AC4 violation: spec commits modified skills/CLAUDE.md: ${JSON.stringify(touched)}`
    );
  });
});

// --- 2. Wizard call-site wiring (R004.AC3) ---------------------------------

suite('wizard call-sites: four commands invoke forge-wizard.cjs', () => {
  for (const cmd of ['brainstorm.md', 'plan.md', 'execute.md', 'status.md']) {
    test(`commands/${cmd} invokes scripts/forge-wizard.cjs`, () => {
      const body = _readCommandFile(cmd);
      assert.ok(
        _hasWizardInvocation(body),
        `commands/${cmd} is missing the wizard invocation. ` +
        `Expected a bash line matching: ` +
        `node "\${CLAUDE_PLUGIN_ROOT}/scripts/forge-wizard.cjs" --forge-dir .forge`
      );
    });

    test(`commands/${cmd} places wizard call at the start of execution`, () => {
      const body = _readCommandFile(cmd);
      const wizPos = _wizardCallSitePosition(body);
      assert.notStrictEqual(wizPos, -1, `wizard invocation missing in ${cmd}`);
      const firstBash = _firstSubstantiveBashAfterFrontmatter(body);
      assert.notStrictEqual(firstBash, -1,
        `no bash fence found in ${cmd} (parser bug or empty file)`);
      // The wizard call must be at-or-before the first bash fence after
      // the frontmatter. (If it IS the first bash fence, the two offsets
      // are within a few bytes of each other.) We allow a small tolerance
      // for the surrounding ```bash\n preamble.
      assert.ok(
        wizPos <= firstBash + 32,
        `wizard call at byte ${wizPos} comes after first bash fence at ${firstBash} in ${cmd}; ` +
        `it must run before any other action`
      );
    });
  }

  test('all four call-sites use the same canonical invocation form', () => {
    // Style consistency: same flag, same script path. Reviewers can't
    // tell at a glance if one command uses --forge-dir .forge and another
    // uses .forge/ -- this test pins it.
    const canonical = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/forge-wizard.cjs" --forge-dir .forge';
    for (const cmd of ['brainstorm.md', 'plan.md', 'execute.md', 'status.md']) {
      const body = _readCommandFile(cmd);
      assert.ok(
        body.includes(canonical),
        `commands/${cmd} does not contain the canonical invocation: ${canonical}`
      );
    }
  });

  test('allowed-tools frontmatter permits forge-wizard.cjs in all four commands', () => {
    // The Bash() permission grammar is exact: if the frontmatter does not
    // list forge-wizard.cjs, the harness will block the call at runtime.
    for (const cmd of ['brainstorm.md', 'plan.md', 'execute.md', 'status.md']) {
      const body = _readCommandFile(cmd);
      const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, `${cmd} missing frontmatter`);
      const fm = fmMatch[1];
      // Either an explicit forge-wizard.cjs allow rule, or a Bash(*) wildcard.
      const hasExplicit = /forge-wizard\.cjs/.test(fm);
      const hasWildcard = /"Bash\(\*\)"/.test(fm);
      assert.ok(
        hasExplicit || hasWildcard,
        `${cmd} allowed-tools does not permit forge-wizard.cjs ` +
        `(neither explicit rule nor Bash(*) wildcard found)`
      );
    }
  });
});

// --- 3. Wizard double-render guard (R004.AC6) ------------------------------

suite('wizard does not double-render when TUI is active (R004.AC6)', () => {
  // We exercise the wizard module directly with a synthetic state.md that
  // has tui_active: true. The unit test in forge-wizard.test.cjs already
  // covers this contract; the test here is a higher-level integration
  // sanity check tied to the command-wiring task.

  function captureStdout(fn) {
    const original = process.stdout.write.bind(process.stdout);
    let buf = '';
    process.stdout.write = (chunk) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try { fn(); } finally { process.stdout.write = original; }
    return buf;
  }

  function loadFreshWizard() {
    delete require.cache[WIZARD_PATH];
    return require(WIZARD_PATH);
  }

  test('TUI active in state.md => wizard is silent and does not consume the dismissal', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: watching\ntui_active: true\n---\n\n## What\'s Done\n'
    );
    const { runWizard } = loadFreshWizard();
    let result;
    const out = captureStdout(() => { result = runWizard(forgeDir); });
    assert.strictEqual(result.printed, false, 'wizard must be silent when TUI is active');
    assert.strictEqual(result.reason, 'tui-active');
    assert.strictEqual(out, '', 'no output when TUI is active');
    // The dismissal must NOT be consumed -- otherwise a user who runs
    // /forge:watch first would never see the wizard.
    const cfg = JSON.parse(fs.readFileSync(path.join(forgeDir, 'config.json'), 'utf8'));
    assert.notStrictEqual(cfg.wizard_completed, true,
      'TUI suppression must leave wizard_completed unset so the wizard can fire after the TUI exits');
  });

  test('TUI inactive => wizard fires normally on the very next call', () => {
    // Sequence: TUI on -> wizard silent. Then TUI flag flipped off ->
    // wizard fires once. This is the exact handoff /forge:watch -> /forge:status.
    const { forgeDir } = makeTempForgeDir({ config: {} });
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: watching\ntui_active: true\n---\n\n## What\'s Done\n'
    );
    const { runWizard } = loadFreshWizard();
    captureStdout(() => runWizard(forgeDir)); // silent

    // TUI exits.
    fs.writeFileSync(
      path.join(forgeDir, 'state.md'),
      '---\nphase: ready\ntui_active: false\n---\n\n## What\'s Done\n'
    );
    let result;
    const out = captureStdout(() => { result = runWizard(forgeDir); });
    assert.strictEqual(result.printed, true);
    assert.strictEqual(result.reason, 'first-run');
    assert.ok(out.length > 0, 'banner must print after TUI exits');
  });
});

// --- 4. Wizard kill-switch end-to-end (R004.AC5) ---------------------------

suite('wizard kill-switch end-to-end (R004.AC5)', () => {
  function captureStdout(fn) {
    const original = process.stdout.write.bind(process.stdout);
    let buf = '';
    process.stdout.write = (chunk) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try { fn(); } finally { process.stdout.write = original; }
    return buf;
  }

  test('FORGE_TOKEN_OPT=0 prints disabled notice and consumes the dismissal', () => {
    const { forgeDir } = makeTempForgeDir({ config: {} });
    process.env.FORGE_TOKEN_OPT = '0';
    try {
      delete require.cache[WIZARD_PATH];
      const { runWizard } = require(WIZARD_PATH);
      let result;
      const out = captureStdout(() => { result = runWizard(forgeDir); });
      assert.strictEqual(result.printed, true);
      assert.strictEqual(result.reason, 'kill-switch');
      assert.ok(/disabled/i.test(out), 'disabled notice must mention "disabled"');
      const cfg = JSON.parse(fs.readFileSync(path.join(forgeDir, 'config.json'), 'utf8'));
      assert.strictEqual(cfg.wizard_completed, true,
        'kill-switch path must consume the dismissal so the message does not re-fire');
    } finally {
      delete process.env.FORGE_TOKEN_OPT;
    }
  });
});

runTests();
