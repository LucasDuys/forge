// tests/forge-collab-enabled-marker.test.cjs -- explicit .enabled marker + recover (T028, R008)
//
// Covers spec-collab-fix R008 acceptance criteria:
//   AC1: /forge:collaborate start writes .enabled as its final action.
//   AC2: collab-mode-active CLI checks .enabled (not participant.json).
//   AC3: /forge:collaborate leave deletes .enabled first, then participant.json.
//   AC4: /forge:collaborate recover diagnoses stale state + offers remedy.
//   AC5: Unit tests cover all four state-pair configurations.
//
// Also covers the task-prompt forward-compat rule: the collab-mode-active
// CLI silently creates `.enabled` when `participant.json` exists but the
// marker does not (pre-T028 session carried across the upgrade).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const collab = require('../scripts/forge-collab.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const FORGE_TOOLS_CJS = path.join(REPO_ROOT, 'scripts', 'forge-tools.cjs');

function mkTempForge() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-enabled-marker-'));
  const forgeDir = path.join(projectDir, '.forge');
  fs.mkdirSync(path.join(forgeDir, 'collab'), { recursive: true });
  return { projectDir, forgeDir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function writeParticipant(forgeDir, data) {
  fs.writeFileSync(
    path.join(forgeDir, 'collab', 'participant.json'),
    JSON.stringify(data || { handle: 'alice', session_id: 'abc123deadbeef', started: '2026-04-20T00:00:00Z' })
  );
}

// ------------------------------------------------------------------ AC5 ---
// Four state-pair configurations: {neither, participant-only, enabled-only,
// both}. classifyCollabState must return the correct status for each.
// ---------------------------------------------------------------------------

suite('R008 AC5 -- classifyCollabState returns correct status for 4 state-pair configurations', () => {
  test('neither marker present -> status=inactive, actionable=false', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      const r = collab.classifyCollabState(forgeDir);
      assert.strictEqual(r.status, 'inactive');
      assert.strictEqual(r.actionable, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('participant-only (crash before .enabled landed) -> status=stale_participant, remedy=reset', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      const r = collab.classifyCollabState(forgeDir);
      assert.strictEqual(r.status, 'stale_participant');
      assert.strictEqual(r.actionable, true);
      assert.strictEqual(r.remedy, 'reset');
    } finally {
      cleanup(projectDir);
    }
  });

  test('.enabled-only (crash after participant.json deleted) -> status=stale_enabled, remedy=repair', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.classifyCollabState(forgeDir);
      assert.strictEqual(r.status, 'stale_enabled');
      assert.strictEqual(r.actionable, true);
      assert.strictEqual(r.remedy, 'repair');
    } finally {
      cleanup(projectDir);
    }
  });

  test('both present + session id matches current origin -> status=healthy, actionable=false', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir, { handle: 'alice', session_id: 'match123', started: '2026-04-20T00:00:00Z' });
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.classifyCollabState(forgeDir, { sessionIdResolver: () => 'match123' });
      assert.strictEqual(r.status, 'healthy');
      assert.strictEqual(r.actionable, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('both present but session_id mismatches origin -> status=session_mismatch, remedy=migrate', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir, { handle: 'alice', session_id: 'oldsession', started: '2026-04-20T00:00:00Z' });
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.classifyCollabState(forgeDir, { sessionIdResolver: () => 'newsession' });
      assert.strictEqual(r.status, 'session_mismatch');
      assert.strictEqual(r.remedy, 'migrate');
      assert.strictEqual(r.current_session_id, 'newsession');
      assert.strictEqual(r.participant_session_id, 'oldsession');
    } finally {
      cleanup(projectDir);
    }
  });

  test('both present + origin unreachable -> classifier skips mismatch check, treats as healthy', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.classifyCollabState(forgeDir, {
        sessionIdResolver: () => { throw new Error('no origin'); }
      });
      assert.strictEqual(r.status, 'healthy');
    } finally {
      cleanup(projectDir);
    }
  });
});

// ------------------------------------------------------------------ AC1 ---
// /forge:collaborate start writes participant.json FIRST, then .enabled
// LAST. Verify via an fs.writeFileSync spy that captures the call order.
// The skill delegates writes to writeEnabledMarker; callers write
// participant.json via fs.writeFileSync themselves. We simulate the
// documented start sequence and assert the ordering invariant.
// ---------------------------------------------------------------------------

suite('R008 AC1 -- start writes participant.json then .enabled in order', () => {
  test('documented start sequence yields participant-before-enabled fs call order', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      const order = [];
      const origWrite = fs.writeFileSync;
      fs.writeFileSync = function (p, data, enc) {
        const base = path.basename(String(p));
        if (base === 'participant.json' || base === '.enabled') {
          order.push(base);
        }
        return origWrite.call(fs, p, data, enc);
      };

      try {
        // Step 4 of the SKILL.md: write participant.json FIRST.
        fs.writeFileSync(
          path.join(forgeDir, 'collab', 'participant.json'),
          JSON.stringify({ handle: 'alice', session_id: 'sess', started: 'now' })
        );
        // Step 5: write .enabled via the primitive LAST.
        collab.writeEnabledMarker(forgeDir);
      } finally {
        fs.writeFileSync = origWrite;
      }

      assert.deepStrictEqual(order, ['participant.json', '.enabled']);
      assert.ok(fs.existsSync(path.join(forgeDir, 'collab', '.enabled')));
      assert.ok(fs.existsSync(path.join(forgeDir, 'collab', 'participant.json')));
    } finally {
      cleanup(projectDir);
    }
  });

  test('writeEnabledMarker is idempotent (no throw when marker already exists)', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      collab.writeEnabledMarker(forgeDir);
      collab.writeEnabledMarker(forgeDir); // second call must not throw
      assert.ok(fs.existsSync(path.join(forgeDir, 'collab', '.enabled')));
    } finally {
      cleanup(projectDir);
    }
  });

  test('writeEnabledMarker creates collab dir when missing', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.rmSync(path.join(forgeDir, 'collab'), { recursive: true, force: true });
      collab.writeEnabledMarker(forgeDir);
      assert.ok(fs.existsSync(path.join(forgeDir, 'collab', '.enabled')));
    } finally {
      cleanup(projectDir);
    }
  });
});

// ------------------------------------------------------------------ AC3 ---
// /forge:collaborate leave deletes .enabled FIRST, then participant.json.
// Verify via an fs.rmSync spy that captures the delete order.
// ---------------------------------------------------------------------------

suite('R008 AC3 -- leave deletes .enabled first then participant.json', () => {
  test('documented leave sequence yields enabled-before-participant fs delete order', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');

      const order = [];
      const origRm = fs.rmSync;
      fs.rmSync = function (p, opts) {
        const base = path.basename(String(p));
        if (base === 'participant.json' || base === '.enabled') {
          order.push(base);
        }
        return origRm.call(fs, p, opts);
      };

      try {
        // Step 2: delete .enabled FIRST via the primitive.
        collab.removeEnabledMarker(forgeDir);
        // Steps 3-5 (release claims + disconnect) have no filesystem
        // footprint in this unit scope.
        // Step 6: delete participant.json LAST.
        fs.rmSync(path.join(forgeDir, 'collab', 'participant.json'), { force: true });
      } finally {
        fs.rmSync = origRm;
      }

      assert.deepStrictEqual(order, ['.enabled', 'participant.json']);
      assert.ok(!fs.existsSync(path.join(forgeDir, 'collab', '.enabled')));
      assert.ok(!fs.existsSync(path.join(forgeDir, 'collab', 'participant.json')));
    } finally {
      cleanup(projectDir);
    }
  });

  test('removeEnabledMarker returns true when marker existed, false when it did not', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      assert.strictEqual(collab.removeEnabledMarker(forgeDir), false);
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      assert.strictEqual(collab.removeEnabledMarker(forgeDir), true);
      assert.strictEqual(collab.removeEnabledMarker(forgeDir), false);
    } finally {
      cleanup(projectDir);
    }
  });
});

// ------------------------------------------------------------------ AC2 ---
// collab-mode-active CLI returns exit 0 iff .enabled is present, exit 1
// otherwise. Forward-compat: participant-only state silently creates
// .enabled on invocation.
// ---------------------------------------------------------------------------

suite('R008 AC2 -- collab-mode-active CLI checks .enabled, not participant.json', () => {
  function runCli(forgeDir) {
    return spawnSync('node', [FORGE_TOOLS_CJS, 'collab-mode-active', '--forge-dir', forgeDir], {
      encoding: 'utf8',
      timeout: 10000
    });
  }

  test('.enabled present -> exit 0, stdout "true"', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = runCli(forgeDir);
      assert.strictEqual(r.status, 0);
      assert.match(r.stdout, /true/);
    } finally {
      cleanup(projectDir);
    }
  });

  test('neither marker present -> exit 1, stdout "false"', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      const r = runCli(forgeDir);
      assert.strictEqual(r.status, 1);
      assert.match(r.stdout, /false/);
    } finally {
      cleanup(projectDir);
    }
  });

  test('participant.json only (pre-T028 session) -> CLI silently migrates + exit 0', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      assert.ok(!fs.existsSync(path.join(forgeDir, 'collab', '.enabled')));

      const r = runCli(forgeDir);

      assert.strictEqual(r.status, 0, 'CLI should exit 0 after silent migration');
      assert.match(r.stdout, /true/);
      // Forward-compat: the CLI must have dropped .enabled in place.
      assert.ok(
        fs.existsSync(path.join(forgeDir, 'collab', '.enabled')),
        'CLI should have written .enabled when it found a pre-T028 session'
      );
    } finally {
      cleanup(projectDir);
    }
  });

  test('collabModeEnabled helper matches CLI exit semantics', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      assert.strictEqual(collab.collabModeEnabled(forgeDir), false);
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      assert.strictEqual(collab.collabModeEnabled(forgeDir), true);
    } finally {
      cleanup(projectDir);
    }
  });
});

// ------------------------------------------------------------------ AC4 ---
// /forge:collaborate recover scans for stale state and offers the right
// remedy for each case. Cover reset (participant-only), repair
// (enabled-only), migrate (session mismatch), and no-op (healthy).
// ---------------------------------------------------------------------------

suite('R008 AC4 -- recover diagnoses stale state and offers the right remedy', () => {
  test('participant-only + dry-run -> remedy=reset, applied=false', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      const r = collab.recoverCollabState(forgeDir);
      assert.strictEqual(r.status, 'stale_participant');
      assert.strictEqual(r.remedy, 'reset');
      assert.strictEqual(r.applied, false);
      assert.ok(fs.existsSync(path.join(forgeDir, 'collab', 'participant.json')));
    } finally {
      cleanup(projectDir);
    }
  });

  test('participant-only + apply:true -> deletes participant.json, reports applied', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir);
      const r = collab.recoverCollabState(forgeDir, { apply: true });
      assert.strictEqual(r.applied, true);
      assert.ok(Array.isArray(r.actions));
      assert.ok(r.actions.includes('removed_participant'));
      assert.ok(!fs.existsSync(path.join(forgeDir, 'collab', 'participant.json')));
    } finally {
      cleanup(projectDir);
    }
  });

  test('enabled-only + apply:true + injected session id -> repair writes participant.json', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.recoverCollabState(forgeDir, {
        apply: true,
        sessionIdResolver: () => 'recovered-session',
        handleResolver: () => 'alice'
      });
      assert.strictEqual(r.remedy, 'repair');
      assert.strictEqual(r.applied, true);
      const pPath = path.join(forgeDir, 'collab', 'participant.json');
      assert.ok(fs.existsSync(pPath));
      const p = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      assert.strictEqual(p.handle, 'alice');
      assert.strictEqual(p.session_id, 'recovered-session');
      assert.strictEqual(p.recovered, true);
    } finally {
      cleanup(projectDir);
    }
  });

  test('enabled-only + apply:true + no origin -> repair reports not-applied with reason', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.recoverCollabState(forgeDir, {
        apply: true,
        sessionIdResolver: () => { throw new Error('no origin'); },
        handleResolver: () => 'alice'
      });
      assert.strictEqual(r.remedy, 'repair');
      assert.strictEqual(r.applied, false);
      assert.match(r.reason, /origin/i);
    } finally {
      cleanup(projectDir);
    }
  });

  test('session_mismatch + apply:true -> migrate rewrites session_id + records migrated_from', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir, { handle: 'alice', session_id: 'old', started: '2026-04-20T00:00:00Z' });
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.recoverCollabState(forgeDir, {
        apply: true,
        sessionIdResolver: () => 'new'
      });
      assert.strictEqual(r.remedy, 'migrate');
      assert.strictEqual(r.applied, true);
      const p = JSON.parse(fs.readFileSync(path.join(forgeDir, 'collab', 'participant.json'), 'utf8'));
      assert.strictEqual(p.session_id, 'new');
      assert.strictEqual(p.migrated_from, 'old');
      assert.ok(p.migrated_at);
    } finally {
      cleanup(projectDir);
    }
  });

  test('healthy state -> recover is a no-op', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      writeParticipant(forgeDir, { handle: 'alice', session_id: 'match', started: 'now' });
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.recoverCollabState(forgeDir, {
        apply: true,
        sessionIdResolver: () => 'match'
      });
      assert.strictEqual(r.status, 'healthy');
      assert.strictEqual(r.applied, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('inactive state -> recover is a no-op (nothing to repair)', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      const r = collab.recoverCollabState(forgeDir, { apply: true });
      assert.strictEqual(r.status, 'inactive');
      assert.strictEqual(r.applied, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('unreadable participant.json -> classifier treats as stale_participant', () => {
    const { projectDir, forgeDir } = mkTempForge();
    try {
      fs.writeFileSync(path.join(forgeDir, 'collab', 'participant.json'), '{not valid json');
      fs.writeFileSync(path.join(forgeDir, 'collab', '.enabled'), '');
      const r = collab.classifyCollabState(forgeDir, { sessionIdResolver: () => 'any' });
      assert.strictEqual(r.status, 'stale_participant');
      assert.strictEqual(r.remedy, 'reset');
    } finally {
      cleanup(projectDir);
    }
  });
});

runTests();
