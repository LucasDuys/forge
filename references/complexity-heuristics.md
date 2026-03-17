# Complexity Heuristics

Forge auto-detects task complexity to recommend a depth level. Override with `--depth`.

## Signals → Simple (recommend: quick)
- Single file or few files affected
- Clear, specific task description
- No cross-component dependencies
- Familiar technology (matches existing codebase patterns)
- Bug fix or small enhancement

## Signals → Medium (recommend: standard)
- Multiple files across 2-3 directories
- New feature with defined scope
- Some cross-component dependencies
- Standard technology stack
- Requires tests but no architectural decisions

## Signals → Complex (recommend: thorough)
- Touches many files across multiple directories
- New system or subsystem
- Cross-repo dependencies
- Unfamiliar technology or novel approach
- Architectural decisions required
- Security-sensitive code
- Multi-domain spec decomposition needed

## Scoring (used by forge-complexity agent)
Each signal adds weight. Sum determines recommendation:
- Score 0-3: quick
- Score 4-7: standard
- Score 8+: thorough
