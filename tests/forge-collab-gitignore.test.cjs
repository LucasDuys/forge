// tests/forge-collab-gitignore.test.cjs -- collab .gitignore carve-out + migration helper (T001, R001)
//
// Covers spec-collab-fix R001 acceptance criteria:
//   1. setup.sh writes carve-out rules + nested .forge/collab/.gitignore
//   2. Existing checkouts: detectLegacyGitignore + patchGitignore migrate old rules
//   3. git check-ignore .forge/collab/inputs-*.md -> not ignored (fresh init)
//   4. git check-ignore .forge/collab/participant.json -> ignored (fresh init)
//   5. Two-clone E2E: inputs-<handle>.md propagates via git push/pull

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, assert, gitAvailable, runTests } = require('./_helper.cjs');
const collab = require('../scripts/forge-collab.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SETUP_SH = path.join(REPO_ROOT, 'scripts', 'setup.sh');

function bashAvailable() {
  try {
    execFileSync('bash', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function runSetup(projectDir) {
  // Invoke setup.sh with the test project as its target. CLAUDE_PLUGIN_ROOT
  // must point at the repo root so setup.sh finds templates/.
  const env = Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: REPO_ROOT });
  const r = spawnSync('bash', [SETUP_SH, projectDir], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error('setup.sh failed: ' + (r.stderr || r.stdout || 'no output'));
  }
  return r;
}

function checkIgnore(cwd, target) {
  // Exit status 0 means the path IS ignored; non-zero means not ignored.
  const r = spawnSync('git', ['check-ignore', '-q', target], { cwd, encoding: 'utf8' });
  return r.status === 0; // true iff ignored
}

suite('setup.sh writes .gitignore carve-out (R001 AC1)', () => {
  test('fresh init writes carve-out block to .gitignore + nested collab .gitignore', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-gitignore-setup-');
    try {
      gitInit(dir);
      runSetup(dir);

      const rootIgnore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.match(rootIgnore, /# forge: collab carve-out/);
      assert.match(rootIgnore, /^\/\.forge\/\*\s*$/m);
      assert.match(rootIgnore, /^!\/\.forge\/collab\/\s*$/m);
      assert.match(rootIgnore, /^!\/\.forge\/collab\/\*\*\s*$/m);

      const nestedPath = path.join(dir, '.forge', 'collab', '.gitignore');
      assert.ok(fs.existsSync(nestedPath), 'nested .forge/collab/.gitignore should exist');
      const nested = fs.readFileSync(nestedPath, 'utf8');
      assert.match(nested, /^participant\.json\s*$/m);
      assert.match(nested, /^flag-emit-log-\*\.jsonl\s*$/m);
    } finally {
      cleanup(dir);
    }
  });

  test('setup.sh is idempotent -- running twice does not duplicate the carve-out block', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-gitignore-idem-');
    try {
      gitInit(dir);
      runSetup(dir);
      // Second run should be guarded by the config.json idempotency gate.
      runSetup(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      const markerCount = (content.match(/# forge: collab carve-out/g) || []).length;
      assert.strictEqual(markerCount, 1, 'carve-out marker should appear exactly once');
    } finally {
      cleanup(dir);
    }
  });

  test('setup.sh preserves user .gitignore entries when adding carve-out', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-gitignore-preserve-');
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
      runSetup(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.match(content, /^node_modules\/\s*$/m);
      assert.match(content, /^\.env\s*$/m);
      assert.match(content, /# forge: collab carve-out/);
    } finally {
      cleanup(dir);
    }
  });
});

suite('git check-ignore on fresh init (R001 AC3, AC4)', () => {
  test('AC3 -- .forge/collab/inputs-lucas.md is NOT ignored', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-checkignore-inputs-');
    try {
      gitInit(dir);
      runSetup(dir);
      // Also test the brainstorm subdir form since brainstormDump writes there.
      const ignored = checkIgnore(dir, '.forge/collab/inputs-lucas.md');
      assert.strictEqual(ignored, false, '.forge/collab/inputs-lucas.md should NOT be ignored');

      const ignoredNested = checkIgnore(dir, '.forge/collab/brainstorm/inputs-lucas.md');
      assert.strictEqual(ignoredNested, false, '.forge/collab/brainstorm/inputs-lucas.md should NOT be ignored');
    } finally {
      cleanup(dir);
    }
  });

  test('AC4 -- .forge/collab/participant.json IS ignored', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-checkignore-participant-');
    try {
      gitInit(dir);
      runSetup(dir);
      const ignored = checkIgnore(dir, '.forge/collab/participant.json');
      assert.strictEqual(ignored, true, '.forge/collab/participant.json should be ignored by nested .gitignore');
    } finally {
      cleanup(dir);
    }
  });

  test('flag-emit-log-<handle>.jsonl is ignored; shared flags under flags/ are not', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-checkignore-logs-');
    try {
      gitInit(dir);
      runSetup(dir);
      assert.strictEqual(
        checkIgnore(dir, '.forge/collab/flag-emit-log-alice.jsonl'),
        true,
        'per-machine flag log should be ignored'
      );
      assert.strictEqual(
        checkIgnore(dir, '.forge/collab/flags/FLAG-123.json'),
        false,
        'shared flag artifact should be tracked'
      );
    } finally {
      cleanup(dir);
    }
  });

  test('baseline .forge/state.md is ignored (outside collab/)', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-checkignore-state-');
    try {
      gitInit(dir);
      runSetup(dir);
      assert.strictEqual(
        checkIgnore(dir, '.forge/state.md'),
        true,
        '.forge/state.md must remain ignored -- carve-out is scoped to collab/'
      );
    } finally {
      cleanup(dir);
    }
  });
});

suite('detectLegacyGitignore (R001 AC2 -- detection half)', () => {
  test('returns ok=true after setup.sh has run', () => {
    if (!gitAvailable() || !bashAvailable()) return;
    const dir = mkTempDir('forge-detect-ok-');
    try {
      gitInit(dir);
      runSetup(dir);
      const r = collab.detectLegacyGitignore({ cwd: dir });
      assert.strictEqual(r.needsPatching, false);
      assert.strictEqual(r.status, 'ok');
    } finally {
      cleanup(dir);
    }
  });

  test('detects legacy bare `.forge/` rule', () => {
    const dir = mkTempDir('forge-detect-legacy-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.forge/\n.env\n');
      const r = collab.detectLegacyGitignore({ cwd: dir });
      assert.strictEqual(r.needsPatching, true);
      assert.strictEqual(r.status, 'legacy_rule_no_carve_out');
      assert.match(r.reason, /Legacy|carve-out/);
    } finally {
      cleanup(dir);
    }
  });

  test('detects missing .gitignore entirely', () => {
    const dir = mkTempDir('forge-detect-missing-');
    try {
      const r = collab.detectLegacyGitignore({ cwd: dir });
      assert.strictEqual(r.needsPatching, true);
      assert.strictEqual(r.status, 'missing_gitignore');
    } finally {
      cleanup(dir);
    }
  });

  test('detects gitignore without any .forge/ rule', () => {
    const dir = mkTempDir('forge-detect-no-rule-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
      const r = collab.detectLegacyGitignore({ cwd: dir });
      assert.strictEqual(r.needsPatching, true);
      assert.strictEqual(r.status, 'missing_forge_rule');
    } finally {
      cleanup(dir);
    }
  });

  test('detects carve-out present but nested gitignore missing', () => {
    const dir = mkTempDir('forge-detect-nested-gone-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), collab.GITIGNORE_CARVE_OUT_BLOCK);
      // No .forge/collab/.gitignore created.
      const r = collab.detectLegacyGitignore({ cwd: dir });
      assert.strictEqual(r.needsPatching, true);
      assert.strictEqual(r.status, 'missing_nested_gitignore');
    } finally {
      cleanup(dir);
    }
  });
});

suite('patchGitignore (R001 AC2 -- patch half)', () => {
  test('patches legacy `.forge/` rule into full carve-out, preserves neighbors', () => {
    if (!gitAvailable()) return;
    const dir = mkTempDir('forge-patch-legacy-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.forge/\n.env\n');
      const r = collab.patchGitignore({ cwd: dir });
      assert.strictEqual(r.patched, true);
      assert.ok(r.actions.includes('replaced_legacy_forge_rule'));
      assert.ok(r.actions.includes('created_nested_gitignore'));

      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.match(content, /# forge: collab carve-out/);
      assert.match(content, /^!\/\.forge\/collab\/\s*$/m);
      assert.match(content, /^node_modules\/\s*$/m, 'neighbor rule preserved');
      assert.match(content, /^\.env\s*$/m, 'neighbor rule preserved');
      // The bare legacy `.forge/` line must have been replaced; exactly one
      // forge-ignore entry remains and it is the carve-out glob form.
      const bareLegacy = content.split(/\r?\n/).filter(l => /^\.forge\/?\s*$/.test(l));
      assert.strictEqual(bareLegacy.length, 0, 'legacy bare .forge/ line should be replaced');
      const caveOutGlob = content.split(/\r?\n/).filter(l => /^\/\.forge\/\*\s*$/.test(l));
      assert.strictEqual(caveOutGlob.length, 1, 'exactly one /.forge/* carve-out line after patch');

      assert.ok(fs.existsSync(path.join(dir, '.forge', 'collab', '.gitignore')));
    } finally {
      cleanup(dir);
    }
  });

  test('creates .gitignore from scratch when missing', () => {
    const dir = mkTempDir('forge-patch-missing-');
    try {
      const r = collab.patchGitignore({ cwd: dir });
      assert.strictEqual(r.patched, true);
      assert.ok(r.actions.includes('created_gitignore'));
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.match(content, /# forge: collab carve-out/);
    } finally {
      cleanup(dir);
    }
  });

  test('appends carve-out when .gitignore exists but has no .forge/ rule', () => {
    const dir = mkTempDir('forge-patch-append-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
      const r = collab.patchGitignore({ cwd: dir });
      assert.strictEqual(r.patched, true);
      assert.ok(r.actions.includes('appended_carve_out_block'));
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.match(content, /^node_modules\/\s*$/m);
      assert.match(content, /# forge: collab carve-out/);
    } finally {
      cleanup(dir);
    }
  });

  test('is idempotent -- second patch is a no-op', () => {
    const dir = mkTempDir('forge-patch-idem-');
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.forge/\n');
      collab.patchGitignore({ cwd: dir });
      const after1 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      const r2 = collab.patchGitignore({ cwd: dir });
      const after2 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.strictEqual(r2.patched, false, 'second patch should be no-op');
      assert.strictEqual(after1, after2, 'file content unchanged');
    } finally {
      cleanup(dir);
    }
  });

  test('patched gitignore makes git check-ignore behave correctly', () => {
    if (!gitAvailable()) return;
    const dir = mkTempDir('forge-patch-checkignore-');
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, '.gitignore'), '.forge/\n');
      collab.patchGitignore({ cwd: dir });
      assert.strictEqual(checkIgnore(dir, '.forge/collab/inputs-alice.md'), false);
      assert.strictEqual(checkIgnore(dir, '.forge/collab/participant.json'), true);
      assert.strictEqual(checkIgnore(dir, '.forge/state.md'), true);
    } finally {
      cleanup(dir);
    }
  });
});

suite('two-clone brainstorm E2E (R001 AC5)', () => {
  test('brainstormDump on clone A propagates to clone B via git push/pull', () => {
    if (!gitAvailable() || !bashAvailable()) return;

    const bareRepo = mkTempDir('forge-e2e-bare-');
    const cloneA = mkTempDir('forge-e2e-alice-');
    const cloneB = mkTempDir('forge-e2e-bob-');

    try {
      // Set up a bare "remote" that both clones share.
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bareRepo]);

      // Clone A: init repo, wire remote, run setup.sh, seed initial commit.
      gitInit(cloneA);
      execFileSync('git', ['remote', 'add', 'origin', bareRepo], { cwd: cloneA });
      fs.writeFileSync(path.join(cloneA, 'README.md'), '# test repo\n');
      runSetup(cloneA);
      execFileSync('git', ['add', '.gitignore', 'README.md', '.forge/collab/.gitignore'], { cwd: cloneA });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: cloneA });
      execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: cloneA });

      // Clone B: clone from the bare remote.
      execFileSync('git', ['clone', '-q', bareRepo, cloneB]);
      execFileSync('git', ['config', 'user.email', 'bob@forge.local'], { cwd: cloneB });
      execFileSync('git', ['config', 'user.name', 'Bob'], { cwd: cloneB });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: cloneB });

      // Clone A: brainstormDump('lucas') and push.
      const collabDirA = path.join(cloneA, '.forge', 'collab');
      const inputsPath = collab.brainstormDump(collabDirA, 'lucas', 'we should use redis for queues');
      const relPath = path.relative(cloneA, inputsPath).split(path.sep).join('/');

      // Ensure the rule-set lets us git-add this path.
      assert.strictEqual(
        checkIgnore(cloneA, relPath),
        false,
        'brainstorm inputs path must not be ignored'
      );
      execFileSync('git', ['add', relPath], { cwd: cloneA });
      execFileSync('git', ['commit', '-q', '-m', 'brainstorm from lucas'], { cwd: cloneA });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: cloneA });

      // Clone B: pull and assert the file arrived.
      execFileSync('git', ['pull', '-q', 'origin', 'main'], { cwd: cloneB });
      const bInputs = path.join(cloneB, relPath);
      assert.ok(fs.existsSync(bInputs), 'inputs-lucas.md should appear on clone B after pull');
      const body = fs.readFileSync(bInputs, 'utf8');
      assert.match(body, /we should use redis for queues/);

      // Clone A: participant.json must NOT reach clone B.
      fs.writeFileSync(
        path.join(collabDirA, 'participant.json'),
        JSON.stringify({ handle: 'lucas', session_id: 'abc123', started: new Date().toISOString() })
      );
      // Try to add it -- should fail with "ignored" message or be silently skipped.
      const addResult = spawnSync('git', ['add', '.forge/collab/participant.json'], {
        cwd: cloneA, encoding: 'utf8'
      });
      // The add may succeed with a warning or fail; key is the file is not staged.
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: cloneA, encoding: 'utf8'
      });
      assert.ok(
        !staged.includes('participant.json'),
        'participant.json must not be stageable (ignored by nested .gitignore)'
      );
      void addResult;
    } finally {
      cleanup(bareRepo);
      cleanup(cloneA);
      cleanup(cloneB);
    }
  });
});

runTests();
