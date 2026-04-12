---
name: graphify-integration
description: Graph-aware planning and research using codebase knowledge graphs — enables architecture-aware task decomposition, dependency discovery, and context reduction
---

# Graphify Integration Skill

This skill enables Forge to leverage codebase knowledge graphs for architecture-aware planning and research. When a graphify knowledge graph exists (or can be generated), Forge agents use it to understand code structure, discover dependencies, prioritize tasks, and reduce context size.

## Prerequisites

Graphify integration is **optional but recommended** for projects with:
- 20+ source files
- Multiple modules or packages
- Cross-component dependencies
- Unfamiliar codebases (new contributor scenario)

## Detection

At the start of `/forge plan` or `/forge execute`, check for an existing knowledge graph:

```bash
# Check for existing graphify output
ls graphify-out/graph.json 2>/dev/null
```

If `graph.json` exists, load it. If not, check if graphify is available:

```bash
# Check if graphify is installed as a skill or CLI
which graphify 2>/dev/null || python -m graphify --help 2>/dev/null
```

If graphify is available but no graph exists, suggest generating one:
```
Note: No knowledge graph found. Run `graphify .` to build one for architecture-aware planning.
Proceeding without graph context.
```

Never block on graph availability. All graph-enhanced features degrade gracefully to standard behavior when no graph is present.

## Graph-Enhanced Planning

When a knowledge graph is available, the forge-planner agent gains these capabilities:

### 1. Architecture-Aware Task Decomposition

Before decomposing specs into tasks, query the graph to understand the codebase structure:

```
Query: "What are the main architectural components?"
Result: god nodes (highest-connectivity concepts), community clusters
```

Use this to:
- Align task boundaries with existing module boundaries (communities)
- Identify god nodes (core abstractions) that many tasks will touch -- these need careful ordering
- Detect cross-cutting concerns that affect multiple communities

### 2. Dependency Discovery

Query the graph to find implicit dependencies not obvious from the spec:

```
Query: "What depends on {module}?"
Result: downstream consumers, shared utilities, integration points
```

Use this to:
- Add dependency edges to the task DAG that the spec alone would miss
- Identify tasks that should be in earlier tiers because they affect shared infrastructure
- Flag tasks that touch god nodes as higher risk (more potential blast radius)

### 3. Task Prioritization by Connectivity

Rank tasks by the connectivity of the code they modify:
- Tasks touching god nodes (high-degree concepts) go in earlier tiers
- Tasks in isolated communities (low cross-cluster edges) can safely run in parallel
- Bridge tasks (connecting two communities) need careful dependency ordering

### 4. Context Reduction for Executors

Instead of loading the full codebase context for each task, query the graph for the relevant subgraph:

```
Query: "Show everything related to {task-target} within depth 3"
Result: relevant nodes, edges, and source files
```

This provides the executor with a focused context window containing only the files and relationships relevant to their task, rather than the entire codebase.

## Graph-Enhanced Research

The forge-researcher agent can use the graph to:

### 1. Pre-Implementation Architecture Scan

Before researching external docs, query the graph to understand what already exists:

```
Query: "Explain {concept}"
Result: all connections to the concept -- what it depends on, what depends on it, which community it belongs to
```

### 2. Impact Analysis

Before implementing a change, query the graph for blast radius:

```
Query: "Path from {source} to {target}"
Result: shortest path through the dependency graph, revealing hidden coupling
```

### 3. Pattern Discovery

Identify how similar patterns are already implemented in the codebase:

```
Query: "Show nodes similar to {pattern} in community {N}"
Result: related implementations that can serve as templates
```

## Graph-Enhanced Review

The forge-reviewer agent can use the graph to:

### 1. Blast Radius Verification

Cross-reference modified files against the graph to find all downstream consumers:

```
Query: "What depends on {modified-file}?"
Result: all files and concepts that consume exports from the modified file
```

### 2. Community Boundary Checks

Verify that changes respect architectural boundaries:

```
Query: "Which community does {file} belong to?"
Result: community assignment, cohesion score, bridge status
```

If a task modifies files in multiple communities without explicit cross-cutting justification, flag for review.

## Integration Points

### In forge-planner (planning phase)
1. Load `graphify-out/graph.json` if it exists
2. Extract god nodes and community structure
3. Use community boundaries to inform task grouping
4. Use node connectivity to inform tier ordering
5. Add graph-discovered dependencies to the frontier DAG

### In forge-researcher (research phase)
1. Query graph for existing implementations before external research
2. Use graph paths for impact analysis
3. Include graph context in research reports under "Codebase Architecture (Graph)"

### In forge-reviewer (review phase)
1. Query graph for blast radius analysis
2. Verify changes respect community boundaries
3. Include graph-based dependency count in review output

### In forge-executor (execution phase)
1. Query graph for focused context (relevant files only)
2. Use graph to find template implementations in the same community
3. Verify no unintended cross-community modifications

## Graph Data Format

Graphify produces `graph.json` in NetworkX node-link format:

```json
{
  "nodes": [
    {"id": "node-1", "label": "UserService", "type": "class", "community": 0, "source": "src/services/user.ts:15"},
    ...
  ],
  "links": [
    {"source": "node-1", "target": "node-2", "type": "DEPENDS_ON", "confidence": "EXTRACTED"},
    ...
  ]
}
```

Key fields:
- `community`: Leiden algorithm cluster ID (group related concepts)
- `confidence`: EXTRACTED (explicit), INFERRED (deduced), AMBIGUOUS (uncertain)
- `type`: Relationship type (DEPENDS_ON, IMPLEMENTS, EXTENDS, CALLS, IMPORTS)

## Graceful Degradation

All graph-enhanced features are additive. When no graph is available:
- Planning falls back to spec-only decomposition (current behavior)
- Research falls back to codebase grep + external docs (current behavior)
- Review falls back to manual blast radius analysis (current behavior)
- Execution falls back to full codebase context (current behavior)

No Forge workflow should ever fail because graphify is unavailable.
