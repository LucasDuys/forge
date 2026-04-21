// scripts/forge-streaming-dag.cjs -- T029 / R006
//
// Per-acceptance-criterion streaming DAG scheduler.
//
// Today's task frontier is task-level: `depends: [T003]`. Downstream blocks
// on full upstream completion even when the specific AC it needs is already
// met. This module extends the scheduler to AC granularity:
//
//   - Tasks declare `depends: [T001.R001.AC3]` and `provides: [R002.AC1]`.
//   - When an upstream executor emits `ac-met` for an AC that downstream
//     lists, the scheduler dispatches the downstream task PROVISIONALLY in
//     its own worktree.
//   - When the upstream task's full review passes (`task-verified`), the
//     provisional downstream promotes to VERIFIED and may merge.
//   - If upstream later regresses the AC (witness hash changes on verify,
//     or explicit `ac-regression`), every downstream that consumed the old
//     witness is marked STALE and re-queued.
//
// Safety caps (acceptance criteria R006):
//   - `maxProvisional` provisional downstreams per upstream chain
//     (default 3). 4th dispatch is denied with reason "cap_exceeded".
//   - `maxFailuresBeforeFallback` verification failures per chain
//     (default 2). After 2, streaming is disabled for that chain and the
//     reason is logged; callers fall back to sequential dispatch.
//
// Design precedents (per docs/audit/research/streaming-dag.md):
//   - Dagster asset-graph + partitions + AutomationCondition (AC-as-partition).
//   - Sherlock (arXiv 2511.00330) -- speculative execution + selective
//     verification + rollback for agentic workflows.
//   - Bazel/Nix content-addressable witness hashes so silent regressions
//     (same AC-id re-fires with different content) invalidate downstream.
//
// Edge primitive on the wire (one structured event, AC acceptance criteria):
//   {
//     task_id: "T001",
//     ac_id: "R001.AC3",
//     state: "provisional" | "verified",
//     witness_hash: "sha256:abc123...",
//     witness_paths: ["src/auth.ts", "tests/auth.test.ts"],
//     emitted_at: "2026-04-20T10:34:00Z"
//   }
//
// Default-on. Set `.forge/config.json` `streaming_dag.enabled: false` to disable.
// When the flag is off the scheduler is never instantiated and existing
// per-task dispatch (parseFrontier + tier planning) runs unchanged.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- dependency parsing ----------
//
// A single entry in `depends:` is one of:
//   - "T001"                  legacy task-level dep, waits for full verify
//   - "T001.R001.AC3"         AC-level dep, waits for ac-met on that AC
//
// An entry in `provides:` is one of:
//   - "register_endpoint"     legacy coarse token, unchanged
//   - "R002.AC1"              AC the task promises to satisfy

const AC_DEP_RE = /^(T\d+(?:\.\d+)?)\.(R\d+\.AC\d+)$/;
const AC_PROVIDE_RE = /^R\d+\.AC\d+$/;

function parseAcDep(dep) {
  if (!dep || typeof dep !== 'string') return null;
  const m = dep.match(AC_DEP_RE);
  if (!m) return null;
  return { taskId: m[1], acId: m[2], raw: dep };
}

function parseAcProvide(provide) {
  if (!provide || typeof provide !== 'string') return null;
  return AC_PROVIDE_RE.test(provide) ? provide : null;
}

function classifyDeps(depsArray) {
  // Returns { taskDeps, acDeps } where taskDeps are legacy task-level ids
  // and acDeps are {taskId, acId} tuples.
  const taskDeps = [];
  const acDeps = [];
  for (const d of (depsArray || [])) {
    if (!d) continue;
    const trimmed = String(d).trim();
    if (!trimmed) continue;
    const ac = parseAcDep(trimmed);
    if (ac) {
      acDeps.push(ac);
    } else if (/^T\d+(?:\.\d+)?$/.test(trimmed)) {
      taskDeps.push(trimmed);
    }
    // Non-matching entries (e.g. stale data) are silently ignored; they
    // would never match an emit anyway.
  }
  return { taskDeps, acDeps };
}

// ---------- witness hashing ----------
//
// SHA-256 of concatenated file contents (in declared order, each preceded
// by its length) so reordering or truncation changes the hash. A missing
// path is treated as an empty blob so the hash is still computable.

function computeWitnessHash(witnessPaths, opts) {
  opts = opts || {};
  const baseDir = opts.baseDir || process.cwd();
  const h = crypto.createHash('sha256');
  for (const rel of (witnessPaths || [])) {
    const abs = path.isAbsolute(rel) ? rel : path.join(baseDir, rel);
    let content;
    try {
      content = fs.readFileSync(abs);
    } catch (_) {
      content = Buffer.alloc(0);
    }
    h.update(String(rel) + '\0');
    h.update(String(content.length) + '\0');
    h.update(content);
  }
  return 'sha256:' + h.digest('hex');
}

// ---------- scheduler ----------
//
// The scheduler is a pure data structure. No I/O except optional log
// writes via `opts.log`. The caller feeds it events and polls the
// dispatch queue; it replies with {ready, provisional, stale, denied}
// lists so the outer scheduler (forge-tools.cjs) can create worktrees,
// mark state, and delegate to the executor agent.

function createStreamingScheduler(opts) {
  opts = opts || {};
  if (!Array.isArray(opts.frontier)) {
    throw new Error('createStreamingScheduler: frontier[] required');
  }
  const maxProvisional = Number.isFinite(opts.maxProvisional)
    ? opts.maxProvisional : 3;
  const maxFailuresBeforeFallback = Number.isFinite(opts.maxFailuresBeforeFallback)
    ? opts.maxFailuresBeforeFallback : 2;
  const log = typeof opts.log === 'function' ? opts.log : function () {};

  // Index tasks by id + index dependencies once.
  const tasks = {};
  const deps = {};         // taskId -> { taskDeps, acDeps }
  const dependents = {};   // upstreamKey (T001 or T001.R001.AC3) -> Set<downstreamTaskId>
  for (const t of opts.frontier) {
    tasks[t.id] = t;
    const { taskDeps, acDeps } = classifyDeps(t.depends);
    deps[t.id] = { taskDeps, acDeps };
    for (const td of taskDeps) {
      (dependents[td] = dependents[td] || new Set()).add(t.id);
    }
    for (const ad of acDeps) {
      (dependents[ad.raw] = dependents[ad.raw] || new Set()).add(t.id);
    }
  }

  // Event + status state.
  const acEvents = {};         // taskId -> acId -> { state, witness_hash, witness_paths, emitted_at }
  const taskVerified = {};     // taskId -> true once task's full review passes
  const consumed = {};         // downstreamTaskId -> { [upstreamKey]: witness_hash }
  const status = {};           // taskId -> 'pending'|'ready'|'provisional'|'verified'|'stale'|'disabled'
  const chainProvisional = {}; // rootTaskId -> count of provisional descendants
  const chainFailures = {};    // rootTaskId -> count of verification failures
  const streamingDisabled = {}; // rootTaskId -> reason string (present = disabled)
  const eventLog = [];         // ordered debug log of every transition

  // Seed status.
  for (const id of Object.keys(tasks)) status[id] = 'pending';

  function _root(taskId) {
    // The "chain root" is the nearest ancestor whose provides a task-level
    // dependency-free seed. For the purposes of streaming caps we treat any
    // task with no AC deps as its own root. This is a cheap approximation of
    // "per upstream chain" as specced; exact graph traversal is overkill
    // given maxProvisional=3 caps apply per task with AC deps.
    const d = deps[taskId];
    if (!d) return taskId;
    if (d.acDeps.length === 0) return taskId;
    // pick the first AC dep's task as the nominal root
    return d.acDeps[0].taskId;
  }

  function _logTransition(kind, detail) {
    eventLog.push(Object.assign({ kind, at: new Date().toISOString() }, detail));
    try { log(kind, detail); } catch (_) { /* best effort */ }
  }

  function _allDepsMet(taskId) {
    // A task is dispatchable when every task-level dep is verified AND
    // every AC-level dep has at least a provisional event present.
    const d = deps[taskId];
    if (!d) return false;
    for (const td of d.taskDeps) {
      if (!taskVerified[td]) return false;
    }
    for (const ad of d.acDeps) {
      const evs = acEvents[ad.taskId];
      if (!evs || !evs[ad.acId]) return false;
    }
    return true;
  }

  function _anyAcDepProvisional(taskId) {
    const d = deps[taskId];
    if (!d || d.acDeps.length === 0) return false;
    for (const ad of d.acDeps) {
      const ev = (acEvents[ad.taskId] || {})[ad.acId];
      if (ev && ev.state === 'provisional') return true;
    }
    return false;
  }

  function _captureConsumed(taskId) {
    const d = deps[taskId];
    if (!d) return;
    const snap = consumed[taskId] = consumed[taskId] || {};
    for (const ad of d.acDeps) {
      // Snapshot-once: downstream captures the witness hash it consumed at
      // dispatch time, never later. A rewrite on the upstream (new ac-met
      // with a different hash, as in the Sherlock-style regression case)
      // must not silently overwrite the consumed snapshot -- that would
      // hide the mismatch the verify step is supposed to catch.
      if (snap[ad.raw] != null) continue;
      const ev = (acEvents[ad.taskId] || {})[ad.acId];
      if (ev && ev.witness_hash) snap[ad.raw] = ev.witness_hash;
    }
  }

  // Attempt to dispatch any waiting task whose deps are newly met.
  // Applies maxProvisional cap. Returns the list of tasks transitioned
  // plus any denials (for observability).
  function _reevaluate() {
    const result = { ready: [], provisional: [], denied: [] };
    for (const id of Object.keys(tasks)) {
      if (status[id] !== 'pending' && status[id] !== 'stale') continue;
      if (!_allDepsMet(id)) continue;

      const speculative = _anyAcDepProvisional(id);
      if (speculative) {
        const root = _root(id);
        if (streamingDisabled[root]) {
          // Fall back: do not promote to provisional; wait for verified.
          continue;
        }
        const live = chainProvisional[root] || 0;
        if (live >= maxProvisional) {
          result.denied.push({ task_id: id, reason: 'cap_exceeded', cap: maxProvisional });
          _logTransition('dispatch_denied', { task_id: id, reason: 'cap_exceeded', cap: maxProvisional });
          continue;
        }
        status[id] = 'provisional';
        chainProvisional[root] = live + 1;
        _captureConsumed(id);
        result.provisional.push(id);
        _logTransition('dispatch_provisional', { task_id: id, root });
      } else {
        status[id] = 'ready';
        _captureConsumed(id);
        result.ready.push(id);
        _logTransition('dispatch_ready', { task_id: id });
      }
    }
    return result;
  }

  // ---------- public API ----------

  function emitAcMet(evt) {
    // evt: { taskId, acId, witnessHash, witnessPaths, emittedAt? }
    if (!evt || !evt.taskId || !evt.acId) {
      throw new Error('emitAcMet: taskId and acId required');
    }
    const bucket = acEvents[evt.taskId] = acEvents[evt.taskId] || {};
    const record = {
      state: 'provisional',
      witness_hash: evt.witnessHash || null,
      witness_paths: Array.isArray(evt.witnessPaths) ? evt.witnessPaths.slice() : [],
      emitted_at: evt.emittedAt || new Date().toISOString()
    };
    bucket[evt.acId] = record;
    _logTransition('ac_met', { task_id: evt.taskId, ac_id: evt.acId, state: 'provisional', witness_hash: record.witness_hash });
    return _reevaluate();
  }

  function emitTaskVerified(evt) {
    // Full review passed. Promote every AC event on this task to `verified`;
    // also promote any provisional downstream that consumed witnesses from
    // this task (if the witnesses still match).
    if (!evt || !evt.taskId) throw new Error('emitTaskVerified: taskId required');
    const taskId = evt.taskId;
    taskVerified[taskId] = true;
    // Verifying a task itself flips its node status so the snapshot reflects
    // the completion even when the task had no AC-level deps of its own.
    if (status[taskId] === 'ready' || status[taskId] === 'provisional') {
      status[taskId] = 'verified';
    }

    const bucket = acEvents[taskId] || {};
    for (const acId of Object.keys(bucket)) {
      if (bucket[acId].state !== 'verified') {
        bucket[acId].state = 'verified';
        _logTransition('ac_verified', { task_id: taskId, ac_id: acId, witness_hash: bucket[acId].witness_hash });
      }
    }

    // Promote provisional downstream consumers of this task's ACs if
    // their captured witness_hash still matches. Otherwise mark stale.
    const result = { promoted: [], stale: [] };
    for (const downstreamId of Object.keys(consumed)) {
      if (status[downstreamId] !== 'provisional') continue;
      const snap = consumed[downstreamId];
      let mismatch = false;
      let touchesThisTask = false;
      for (const key of Object.keys(snap)) {
        const ac = parseAcDep(key);
        if (!ac || ac.taskId !== taskId) continue;
        touchesThisTask = true;
        const live = (acEvents[ac.taskId] || {})[ac.acId];
        if (!live || live.witness_hash !== snap[key]) {
          mismatch = true;
          break;
        }
      }
      if (!touchesThisTask) continue;
      if (mismatch) {
        status[downstreamId] = 'stale';
        const root = _root(downstreamId);
        chainProvisional[root] = Math.max(0, (chainProvisional[root] || 0) - 1);
        chainFailures[root] = (chainFailures[root] || 0) + 1;
        result.stale.push(downstreamId);
        _logTransition('downstream_stale', { task_id: downstreamId, cause: 'witness_mismatch_on_verify', upstream: taskId });
        if (chainFailures[root] >= maxFailuresBeforeFallback && !streamingDisabled[root]) {
          streamingDisabled[root] = 'max_failures_exceeded';
          _logTransition('streaming_disabled', { root, reason: 'max_failures_exceeded', failures: chainFailures[root] });
        }
      } else {
        status[downstreamId] = 'verified';
        const root = _root(downstreamId);
        chainProvisional[root] = Math.max(0, (chainProvisional[root] || 0) - 1);
        result.promoted.push(downstreamId);
        _logTransition('downstream_verified', { task_id: downstreamId, upstream: taskId });
      }
    }
    // A task-level verify may unblock pending tasks that had `depends: T001`.
    const rescan = _reevaluate();
    result.ready = rescan.ready;
    result.provisional = rescan.provisional;
    result.denied = rescan.denied;
    return result;
  }

  function emitAcRegression(evt) {
    // Upstream has regressed this AC. Every downstream that captured the
    // old witness_hash is marked stale and re-queued. Counts toward the
    // chain failure cap.
    if (!evt || !evt.taskId || !evt.acId) {
      throw new Error('emitAcRegression: taskId and acId required');
    }
    const taskId = evt.taskId;
    const acId = evt.acId;

    const bucket = acEvents[taskId] || {};
    const prev = bucket[acId];
    delete bucket[acId];
    _logTransition('ac_regression', { task_id: taskId, ac_id: acId, prev_witness: prev ? prev.witness_hash : null });

    const result = { stale: [] };
    const key = taskId + '.' + acId;
    const root = _root(taskId);
    chainFailures[root] = (chainFailures[root] || 0) + 1;
    for (const downstreamId of Object.keys(consumed)) {
      if (!consumed[downstreamId][key]) continue;
      if (status[downstreamId] === 'pending') continue;
      // Anything that consumed this witness (provisional, verified, or already-ready) is stale.
      const prevStatus = status[downstreamId];
      status[downstreamId] = 'stale';
      if (prevStatus === 'provisional') {
        chainProvisional[root] = Math.max(0, (chainProvisional[root] || 0) - 1);
      }
      delete consumed[downstreamId][key];
      result.stale.push(downstreamId);
      _logTransition('downstream_stale', { task_id: downstreamId, cause: 'ac_regression', upstream: taskId, ac_id: acId });
    }
    if (chainFailures[root] >= maxFailuresBeforeFallback && !streamingDisabled[root]) {
      streamingDisabled[root] = 'max_failures_exceeded';
      _logTransition('streaming_disabled', { root, reason: 'max_failures_exceeded', failures: chainFailures[root] });
    }
    return result;
  }

  function getSnapshot() {
    return {
      status: Object.assign({}, status),
      acEvents: JSON.parse(JSON.stringify(acEvents)),
      taskVerified: Object.assign({}, taskVerified),
      chainProvisional: Object.assign({}, chainProvisional),
      chainFailures: Object.assign({}, chainFailures),
      streamingDisabled: Object.assign({}, streamingDisabled),
      consumed: JSON.parse(JSON.stringify(consumed)),
      events: eventLog.slice()
    };
  }

  function isStreamingDisabled(taskId) {
    return !!streamingDisabled[_root(taskId)];
  }

  return {
    emitAcMet,
    emitTaskVerified,
    emitAcRegression,
    getSnapshot,
    isStreamingDisabled,
    // Exposed for the Mermaid renderer + tests:
    _tasks: tasks,
    _deps: deps,
    _dependents: dependents
  };
}

// ---------- Mermaid rendering ----------
//
// Emits a flowchart string with one subgraph per task, one node per known
// AC, and edges between AC-dep pairs. Live status coloring:
//   - verified   -> green  (classDef ver)
//   - provisional-> yellow (classDef prov)
//   - stale      -> red    (classDef stale)
//   - pending    -> grey   (classDef pend)
//
// The function deliberately keeps output short so `/forge:watch` can
// re-render it on every tick without bloating the dashboard.

function toMermaid(scheduler, opts) {
  opts = opts || {};
  const snap = scheduler.getSnapshot();
  const tasks = scheduler._tasks;
  const deps = scheduler._deps;

  // Collect every AC that's either declared (via provides) or observed (via events).
  const acByTask = {};
  for (const id of Object.keys(tasks)) {
    const provides = (tasks[id].provides || [])
      .map(parseAcProvide).filter(Boolean);
    acByTask[id] = new Set(provides);
  }
  for (const tId of Object.keys(snap.acEvents)) {
    acByTask[tId] = acByTask[tId] || new Set();
    for (const acId of Object.keys(snap.acEvents[tId])) {
      acByTask[tId].add(acId);
    }
  }

  const lines = ['flowchart LR'];
  const verSet = new Set();
  const provSet = new Set();
  const staleSet = new Set();
  const pendSet = new Set();

  // One subgraph per task (sorted for determinism).
  const taskIds = Object.keys(tasks).sort();
  for (const tId of taskIds) {
    const name = tasks[tId].name || tId;
    lines.push('  subgraph ' + tId + '[' + tId + ': ' + _mermaidEscape(name) + ']');
    const acs = Array.from(acByTask[tId] || []).sort();
    if (acs.length === 0) {
      // Render the task body itself as a single node so the subgraph is non-empty.
      const nodeId = tId + '_body';
      lines.push('    ' + nodeId + '[' + _mermaidEscape(tasks[tId].name || tId) + ']');
      const st = snap.status[tId];
      if (st === 'verified') verSet.add(nodeId);
      else if (st === 'provisional') provSet.add(nodeId);
      else if (st === 'stale') staleSet.add(nodeId);
      else pendSet.add(nodeId);
    } else {
      for (const acId of acs) {
        const nodeId = tId + '_' + acId.replace(/\./g, '_');
        lines.push('    ' + nodeId + '[' + _mermaidEscape(acId) + ']');
        const ev = (snap.acEvents[tId] || {})[acId];
        if (ev && ev.state === 'verified') verSet.add(nodeId);
        else if (ev && ev.state === 'provisional') provSet.add(nodeId);
        else pendSet.add(nodeId);
      }
    }
    lines.push('  end');
  }

  // Edges: for each downstream, draw an edge from the upstream AC node.
  for (const dId of taskIds) {
    const d = deps[dId];
    if (!d) continue;
    for (const ac of d.acDeps) {
      const src = ac.taskId + '_' + ac.acId.replace(/\./g, '_');
      const dstAcs = Array.from(acByTask[dId] || []).sort();
      const dst = dstAcs.length > 0
        ? dId + '_' + dstAcs[0].replace(/\./g, '_')
        : dId + '_body';
      lines.push('  ' + src + ' --> ' + dst);
    }
    // Task-level deps draw subgraph-level edges (cheap approximation).
    for (const td of d.taskDeps) {
      lines.push('  ' + td + ' --> ' + dId);
    }
  }

  lines.push('  classDef ver fill:#d4edda,stroke:#155724');
  lines.push('  classDef prov fill:#fff3cd,stroke:#856404');
  lines.push('  classDef stale fill:#f8d7da,stroke:#721c24');
  lines.push('  classDef pend fill:#e2e3e5,stroke:#6c757d');
  if (verSet.size) lines.push('  class ' + Array.from(verSet).join(',') + ' ver');
  if (provSet.size) lines.push('  class ' + Array.from(provSet).join(',') + ' prov');
  if (staleSet.size) lines.push('  class ' + Array.from(staleSet).join(',') + ' stale');
  if (pendSet.size) lines.push('  class ' + Array.from(pendSet).join(',') + ' pend');

  return lines.join('\n');
}

function _mermaidEscape(text) {
  return String(text).replace(/[\[\]"]/g, ' ').trim();
}

// ---------- config helper ----------

function isStreamingEnabled(config) {
  // Default-on: missing config, missing streaming_dag block, or missing
  // `enabled` key all mean on. Only an explicit `enabled: false` turns it off.
  if (!config || typeof config !== 'object') return true;
  const s = config.streaming_dag;
  if (!s || typeof s !== 'object') return true;
  return s.enabled !== false;
}

module.exports = {
  createStreamingScheduler,
  computeWitnessHash,
  parseAcDep,
  parseAcProvide,
  classifyDeps,
  toMermaid,
  isStreamingEnabled
};
