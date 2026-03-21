# Contributing to Forge

Thanks for your interest in contributing.

## Getting Started

1. Fork and clone the repository
2. Load the plugin locally: `claude --plugin-dir /path/to/forge`
3. Make your changes

## Running Tests

```bash
node --test tests/
```

## Project Structure

- `commands/` -- Slash command definitions (markdown prompts)
- `skills/` -- Procedural workflow definitions
- `agents/` -- Specialized subagent prompts
- `hooks/` -- Stop-hook state machine and token monitor
- `scripts/` -- Core utilities (state, config, token math)
- `templates/` -- Output file templates
- `references/` -- Reference documentation

## Commit Messages

Use conventional commits: `feat: add X`, `fix: resolve Y`, `docs: update Z`.

## Pull Requests

- One feature or fix per PR
- Include tests for new functionality
- Keep PRs focused and reviewable
