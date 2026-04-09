// tests/status-block.test.cjs — covers scripts/forge-status-block.cjs
//
// This script is designed to be invoked by hooks/stop-hook.sh as a
// subprocess and prepended to every /forge:execute iteration prompt.
// It must:
//   - Render a compact ASCII block from .forge/ state files
//   - Exit 1 cleanly when .forge/ is missing (caller treats as no-op)
//   - Honor the execute.status_header=false config opt-out
//   - Strip ANSI codes when --no-color is passed
//   - Handle missing optional state files gracefully

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'forge-status-block.cjs');

function runScript(forgeDir, extraArgs = []) {
  const args = [SCRIPT];
  if (forgeDir != null) args.push('--forge-dir', forgeDir);
  args.push('--no-color', ...extraArgs);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmpForge(opts = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-block-'));
  const forge = path.join(project, '.forge');
  fs.mkdirSync(forge, { recursive: true });
  fs.mkdirSync(path.join(forge, 'plans'));
  fs.mkdirSync(path.join(forge, 'progress'));

  if (opts.state !== false) {
    const stateLines = ['---'];
    const fields = Object.assign({
      phase: 'executing',
      current_task: 'T010',
      task_status: 'in_progress',
      blocked_reason: 'null',
    }, opts.state || {});
    for (const [k, v] of Object.entries(fields)) stateLines.push(`${k}: ${v}`);
    stateLines.push('---', '', 'body');
    fs.writeFileSync(path.join(forge, 'state.md'), stateLines.join('\n'));
  }

  if (opts.config) {
    fs.writeFileSync(path.join(forge, 'config.json'), JSON.stringify(opts.config, null, 2));
  }
  if (opts.loop) {
    fs.writeFileSync(path.join(forge, '.forge-loop.json'), JSON.stringify(opts.loop, null, 2));
  }
  if (opts.lock) {
    fs.writeFileSync(path.join(forge, '.forge-loop.lock'), JSON.stringify(opts.lock, null, 2));
  }
  if (opts.ledger) {
    fs.writeFileSync(path.join(forge, 'token-ledger.json'), JSON.stringify(opts.ledger, null, 2));
  }
  if (opts.taskStatus) {
    fs.writeFileSync(path.join(forge, 'task-status.json'), JSON.stringify(opts.taskStatus, null, 2));
  }
  if (opts.frontier) {
    fs.writeFileSync(path.join(forge, 'plans', 'spec-test-frontier.md'), opts.frontier);
  }
  if (opts.checkpoints) {
    for (const [id, cp] of Object.entries(opts.checkpoints)) {
      fs.writeFileSync(path.join(forge, 'progress', `${id}.json`), JSON.stringify(cp, null, 2));
    }
  }

  return forge;
}

suite('forge-status-block :: missing forge dir', () => {
  test('exits 1 with no output when .forge does not exist', () => {
    const fakeDir = path.join(os.tmpdir(), 'forge-status-block-nope-' + Date.now());
    const r = runScript(fakeDir);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.stdout, '');
  });
});

suite('forge-status-block :: opt-out', () => {
  test('exits 1 when execute.status_header is false in config', () => {
    const dir = tmpForge({ config: { execute: { status_header: false } } });
    const r = runScript(dir);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.stdout, '');
  });

  test('renders normally when execute.status_header is true', () => {
    const dir = tmpForge({ config: { execute: { status_header: true } } });
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('FORGE'));
  });
});

suite('forge-status-block :: rendering', () => {
  test('header bar shows iteration counter and phase', () => {
    const dir = tmpForge({
      loop: { iteration: 42, max_iterations: 100 },
      state: { phase: 'executing' },
    });
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    assert.ok(/iteration 42\/100/.test(r.stdout));
    assert.ok(/phase: executing/.test(r.stdout));
  });

  test('task line shows current_task, status, current_step, next_step', () => {
    const dir = tmpForge({
      state: { current_task: 'T010', task_status: 'in_progress' },
      checkpoints: {
        T010: {
          task_id: 'T010', task_name: 't', spec_domain: 's',
          current_step: 'tests_written', next_step: 'tests_passing',
          token_usage: 8400, depth: 'standard',
        },
      },
    });
    const r = runScript(dir);
    assert.ok(/Task\s+T010/.test(r.stdout));
    assert.ok(/\[in_progress\]/.test(r.stdout));
    assert.ok(/tests_written/.test(r.stdout));
    assert.ok(/tests_passing/.test(r.stdout));
  });

  test('progress bar reflects completed/total tasks', () => {
    const dir = tmpForge({
      taskStatus: {
        tasks: {
          T001: { status: 'complete' }, T002: { status: 'complete' }, T003: { status: 'complete' },
          T004: { status: 'running' }, T005: { status: 'pending' },
        },
      },
      frontier: '---\nspec: test\ntotal_tasks: 5\n---\n\n- [T001] a\n- [T002] b\n- [T003] c\n- [T004] d\n- [T005] e\n',
    });
    const r = runScript(dir);
    assert.ok(/3\/5 \(60%\)/.test(r.stdout));
  });

  test('parallel running tasks line appears when more than one running', () => {
    const dir = tmpForge({
      taskStatus: {
        tasks: {
          T002: { status: 'running' }, T003: { status: 'running' }, T004: { status: 'running' },
        },
      },
    });
    const r = runScript(dir);
    assert.ok(/Running T002, T003, T004/.test(r.stdout));
    assert.ok(/3 parallel/.test(r.stdout));
  });

  test('parallel line absent when only one task running', () => {
    const dir = tmpForge({
      taskStatus: { tasks: { T002: { status: 'running' } } },
    });
    const r = runScript(dir);
    assert.ok(!/Running.*parallel/.test(r.stdout));
  });

  test('lock line shows alive when heartbeat is fresh', () => {
    const dir = tmpForge({
      lock: { pid: 18432, started_at: new Date().toISOString(), last_heartbeat: new Date().toISOString() },
    });
    const r = runScript(dir);
    assert.ok(/Lock\s+alive pid 18432/.test(r.stdout));
  });

  test('lock line shows STALE when heartbeat older than 5 minutes', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const dir = tmpForge({
      lock: { pid: 99999, started_at: old, last_heartbeat: old },
    });
    const r = runScript(dir);
    assert.ok(/Lock\s+STALE pid 99999/.test(r.stdout));
  });

  test('lock line shows free when no lock file', () => {
    const dir = tmpForge();
    const r = runScript(dir);
    assert.ok(/Lock\s+free/.test(r.stdout));
  });

  test('per-task budget line shows when checkpoint has token_usage', () => {
    const dir = tmpForge({
      state: { current_task: 'T010' },
      checkpoints: {
        T010: {
          task_id: 'T010', task_name: 't', spec_domain: 's',
          current_step: 'tests_written', next_step: null,
          token_usage: 12000, depth: 'standard',
        },
      },
      config: { per_task_budget: { quick: 5000, standard: 15000, thorough: 40000 }, depth: 'standard' },
    });
    const r = runScript(dir);
    assert.ok(/Per-task 12k\/15k tok \(80%\)/.test(r.stdout));
  });

  test('blocked banner appears when blocked_reason set', () => {
    const dir = tmpForge({
      state: { task_status: 'blocked', blocked_reason: 'human input required' },
    });
    const r = runScript(dir);
    assert.ok(/BLOCKED:/.test(r.stdout));
    assert.ok(/human input required/.test(r.stdout));
  });

  test('--no-color strips all ANSI escape sequences', () => {
    const dir = tmpForge();
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    assert.ok(!/\x1b\[/.test(r.stdout), 'output should contain no ANSI escapes');
  });
});

suite('forge-status-block :: graceful degradation', () => {
  test('renders even when only state.md exists (no loop/lock/ledger)', () => {
    const dir = tmpForge();
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes('FORGE'));
    assert.ok(r.stdout.includes('Task'));
  });

  test('renders when state.md missing too — uses defaults', () => {
    const dir = tmpForge({ state: false });
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    // phase defaults to "unknown"
    assert.ok(r.stdout.includes('phase'));
  });

  test('handles malformed token-ledger.json without crashing', () => {
    const dir = tmpForge();
    fs.writeFileSync(path.join(dir, 'token-ledger.json'), 'not valid json');
    const r = runScript(dir);
    assert.strictEqual(r.code, 0);
    assert.ok(/Tokens/.test(r.stdout));
  });
});

runTests();
