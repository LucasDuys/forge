# Multi-Repo Coordination

## Configuration
Repos are declared in `.forge/config.json` under the `repos` key:
```json
{
  "repos": {
    "api": { "path": "../my-api", "role": "primary", "order": 1 },
    "frontend": { "path": "../my-frontend", "role": "secondary", "order": 2 }
  }
}
```

## Rules
1. **API-first**: When both repos involved, implement API changes before frontend
2. **Commit in source**: Always commit in the repo where changes were made
3. **Read conventions**: Each repo may have its own CLAUDE.md — read and follow it
4. **Reference phases**: Commit messages reference the spec: `feat(spec-auth): add JWT middleware`
5. **Shared specs**: Specs live in `.forge/specs/` (not in either repo)
6. **State is central**: `.forge/` lives in the working directory, not inside any repo

## Task Tags
Each task in the frontier is tagged with `repo:`:
```
- [T001] User model | repo: api
- [T007] Auth context | repo: frontend | depends: T005
```

## Cross-Repo Dependencies
Tasks can depend on tasks in other repos:
- T007 (frontend) depends on T005 (api)
- This means: API endpoint must exist and be committed before frontend work starts
- The executor reads the dependency, verifies the API task is complete, then proceeds
