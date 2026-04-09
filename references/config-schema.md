# Forge Config Schema

This document describes every field accepted by `.forge/config.json`. All fields
are optional. Missing fields fall back to the defaults baked into
`scripts/forge-tools.cjs` (`DEFAULT_CONFIG`). Existing installations are safe:
adding a new field to a future version of Forge will not break an older
`.forge/config.json` because `loadConfig()` deep-merges user values over the
defaults, and `getConfig(cfg, key, fallback)` returns the documented fallback
for any missing path.

The schema is intentionally flat where possible and pure JSON (no comments, no
trailing commas). Boolean fields are `true` or `false`, never `"true"`.

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autonomy` | string | `"gated"` | Autonomy mode. One of `"gated"`, `"auto"`, `"yolo"`. Controls how often the loop pauses for human approval. |
| `depth` | string | `"standard"` | Default execution depth. One of `"quick"`, `"standard"`, `"thorough"`. Determines test ceremony, review iterations, and per-task budget. |
| `auto_detect_depth` | boolean | `true` | When true, the planner auto-classifies each task's depth from complexity heuristics; user can still override. |
| `max_iterations` | number | `100` | Hard ceiling on outer-loop iterations before the run aborts. |
| `token_budget` | number | `500000` | Legacy session-wide token budget. Kept for backward compatibility. New code should prefer `session_budget_tokens`. |
| `session_budget_tokens` | number | `500000` | Session-wide token budget. When cumulative usage in `.forge/token-ledger.json` reaches this number, the loop trips the global circuit breaker (R003). |
| `per_task_budget` | object | see below | Per-task token ceilings keyed by depth (R001). |
| `terse_internal` | boolean | `false` | When true, internal prompts dispatched to subagents are run through the caveman/terse-prompt skill to reduce token cost (R002). Opt-in until validated against quality regressions. |
| `use_worktrees` | boolean | `true` | When true, each task is implemented inside its own git worktree to isolate changes and allow safe parallel execution (R004). |
| `headless_notify_url` | string or null | `null` | Optional URL that receives POST status updates when Forge runs headless. `null` disables headless notifications. |
| `context_reset_threshold` | number | `60` | Percent of context window usage that triggers a context reset and handoff snapshot. |
| `repos` | object | `{}` | Multi-repo definitions. Keys are repo tags, values describe path and base branch. See `references/multi-repo.md`. |
| `cross_repo_rules` | object | see below | Rules governing how cross-repo work is ordered and committed. |
| `loop` | object | see below | Inner-loop circuit-breaker thresholds. |
| `review` | object | see below | Settings for the reviewer subagent. |
| `verification` | object | see below | Settings for the verifier subagent and stub detection. |
| `backprop` | object | see below | Backpropagation behavior when runtime bugs are reported. |
| `capability_hints` | object | `{}` | Optional hints to bias capability discovery. |
| `parallelism` | object | see below | Concurrency limits for parallel task execution. |
| `model_routing` | object | see below | Model-routing rules for subagents. |
| `hooks_config` | object | see below | Toggles for hook-side optimizations. |
| `replanning` | object | see below | Replanning thresholds. |
| `redecomposition` | object | see below | Re-decomposition expansion limits. |
| `codex` | object | see below | Codex rescue and review integration settings. |

## `per_task_budget`

Per-task token ceilings keyed by depth. The loop short-circuits a task that
exceeds its per-task budget instead of letting it consume the entire session
budget.

```json
{
  "per_task_budget": {
    "quick": 5000,
    "standard": 15000,
    "thorough": 40000
  }
}
```

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `quick` | number | `5000` | Token ceiling for tasks at `quick` depth. |
| `standard` | number | `15000` | Token ceiling for tasks at `standard` depth. |
| `thorough` | number | `40000` | Token ceiling for tasks at `thorough` depth. |

## `cross_repo_rules`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `commit_in_source` | boolean | `true` | Commit changes in the repo where files were edited. |
| `api_first` | boolean | `true` | Order tasks so API contract producers run before consumers. |
| `shared_specs` | boolean | `true` | Allow specs to span multiple repos. |

## `loop`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `circuit_breaker_test_fails` | number | `3` | Consecutive test-failure count that flips the loop into debug mode. |
| `circuit_breaker_debug_attempts` | number | `3` | Debug attempts allowed before escalating to human or Codex rescue. |
| `circuit_breaker_review_iterations` | number | `3` | Reviewer iterations allowed per task. |
| `circuit_breaker_no_progress` | number | `2` | Consecutive no-progress turns allowed before halting the loop. |
| `single_task_budget_percent` | number | `20` | Maximum percent of session budget a single task may consume. |

## `review`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable the reviewer subagent. |
| `min_depth` | string | `"standard"` | Minimum task depth that triggers a review. |
| `model` | string | `"claude"` | Model family used for review. |

## `verification`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable the verifier subagent. |
| `min_depth` | string | `"standard"` | Minimum task depth that triggers verification. |
| `stub_detection` | boolean | `true` | Detect TODO and stub implementations. |

## `backprop`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `auto_generate_regression_tests` | boolean | `true` | Generate regression tests when a runtime bug is traced to a spec gap. |
| `re_run_after_spec_update` | boolean | `false` | Re-run the loop after spec updates from backprop. |

## `parallelism`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_concurrent_agents` | number | `3` | Hard cap on concurrent subagents across all repos. |
| `max_concurrent_per_repo` | number | `2` | Per-repo concurrency cap. |

## `model_routing`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable per-role model routing. |
| `cost_weights` | object | `{ haiku: 1, sonnet: 5, opus: 25 }` | Relative cost weights used by the router to bias model selection. |
| `role_baselines` | object | see source | Per-role min/preferred/max model tier. See `references/model-routing.md`. |

## `hooks_config`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `test_filter` | boolean | `true` | Filter test output to relevant lines. |
| `progress_tracker` | boolean | `true` | Enable the progress-tracker hook. |
| `tool_cache` | boolean | `true` | Cache tool results within a session. |
| `tool_cache_ttl` | number | `120` | Cache TTL in seconds. |

## `replanning`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Allow the planner to replan mid-run when concerns accumulate. |
| `concern_threshold` | number | `0.3` | Fraction of tasks reporting concerns that triggers a replan. |

## `redecomposition`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Allow re-decomposition of stuck tasks. |
| `max_expansion_depth` | number | `1` | Maximum recursive expansion depth. |

## `codex`

| Sub-field | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable Codex integration. |
| `review.enabled` | boolean | `true` | Enable Codex-on-Claude review. |
| `review.depth_threshold` | string | `"standard"` | Minimum depth at which Codex review runs. |
| `review.model` | string | `"gpt-5.4-mini"` | Codex model used for review. |
| `review.sensitive_tags` | string[] | `["security","shared","api-export"]` | Task tags that always trigger Codex review. |
| `rescue.enabled` | boolean | `true` | Enable Codex rescue when debug attempts are exhausted. |
| `rescue.debug_attempts_before_rescue` | number | `2` | Debug attempts before Codex rescue is dispatched. |
| `rescue.model` | string or null | `null` | Codex model used for rescue. `null` lets Codex choose. |

## Backward compatibility

When Forge adds a new field, existing `.forge/config.json` files keep working
without modification because:

1. `loadConfig(projectDir)` deep-merges user values over `DEFAULT_CONFIG`, so
   missing keys inherit defaults at load time.
2. Code that needs a single value should use `getConfig(cfg, key, fallback)`,
   which accepts dot-paths (e.g. `per_task_budget.standard`) and returns the
   documented fallback for any missing segment.

This means upgrading Forge never requires editing your config file. You only
need to edit `.forge/config.json` to override a default.

## Example: minimal `.forge/config.json`

```json
{
  "autonomy": "gated",
  "depth": "standard"
}
```

## Example: opting into caveman mode and disabling worktrees

```json
{
  "terse_internal": true,
  "use_worktrees": false,
  "session_budget_tokens": 250000,
  "per_task_budget": {
    "quick": 4000,
    "standard": 12000,
    "thorough": 30000
  }
}
```
