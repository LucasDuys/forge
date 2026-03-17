---
name: brainstorming
description: Interactive spec generation — turn ideas into concrete specs with R-numbered requirements and testable acceptance criteria
---

# Brainstorming Skill

You are running the Forge brainstorming workflow. Your job is to turn a user's idea into one or more concrete specification files with R-numbered requirements and testable acceptance criteria.

## Inputs

The user provides one of:
- **A topic** (plain text describing what they want to build)
- **`--from-code`** flag (analyze the existing codebase to generate specs)
- **`--from-docs PATH`** flag (read documents from PATH, extract requirements)

## Workflow

### Phase 1: Complexity Detection

Before asking questions, determine the scope of the user's request.

Analyze the topic (or codebase/documents) and classify complexity:

| Level | Signals | Question Count |
|-------|---------|----------------|
| **Simple** (single feature, few files, clear scope) | Bug fix, small enhancement, single endpoint, UI tweak | 3-5 questions |
| **Medium** (multi-component, new feature with defined scope) | Multiple files across directories, needs tests, some cross-component work | 8-12 questions |
| **Complex** (multi-domain, architectural decisions, cross-repo) | New system/subsystem, security-sensitive, unfamiliar tech, multi-repo | Decompose into sub-projects first, then 8-12 questions per sub-project |

**Scoring heuristics** (each signal adds 1 point):
- Multiple files across 2+ directories: +1
- Cross-component dependencies: +1
- Cross-repo work needed: +2
- Architectural decisions required: +2
- Security-sensitive code: +1
- New system or subsystem: +2
- Unfamiliar technology or novel approach: +1
- Multi-domain decomposition needed: +2

Score 0-3 = Simple, 4-7 = Medium, 8+ = Complex.

Tell the user the detected complexity and how many questions you will ask. Example: "This looks like a **medium** complexity project. I'll ask about 8-10 questions to nail down the spec."

### Phase 2: Handle Special Modes

#### --from-code mode
1. Use Glob and Grep to scan the project structure
2. Read key files (package.json, config files, main entry points, CLAUDE.md)
3. Identify the tech stack, architecture patterns, existing conventions
4. Generate an initial spec draft based on what you find
5. Present the draft to the user and ask clarifying questions to refine it
6. Skip to Phase 4 (approach proposals) with the refined spec

#### --from-docs mode
1. Read all files from the specified PATH (markdown, text, PDF, CSV)
2. Extract requirements, user stories, acceptance criteria from the documents
3. Organize into domains and R-numbered requirements
4. Present the extracted spec to the user for validation
5. Ask clarifying questions for any ambiguous requirements
6. Skip to Phase 4 (approach proposals) with the refined spec

### Phase 3: Interactive Q&A

**Rules — follow these strictly:**

1. **ONE question at a time.** Never ask multiple questions in a single message.
2. **Multiple choice preferred.** When possible, present 2-4 options for the user to pick from. Example:
   > How should authentication work?
   > A) JWT tokens (stateless, good for APIs)
   > B) Session cookies (simpler, good for web apps)
   > C) OAuth2 with external provider (Google, GitHub, etc.)
   > D) Something else (describe)
3. **YAGNI ruthlessly.** If a feature sounds like premature optimization or speculative, gently push back. "Do you need that for v1, or can we add it later?"
4. **Start broad, narrow down.** First questions should establish scope and architecture. Later questions refine details.
5. **Adapt to answers.** If the user's answers reveal the project is simpler (or more complex) than initially detected, adjust the remaining question count accordingly.
6. **Summarize periodically.** After every 3-4 answers, briefly summarize what you've captured so far and confirm it's correct before continuing.

**Question progression for a typical project:**

1. What is the core problem this solves? (open-ended)
2. Who are the users? (multiple choice if obvious categories exist)
3. What's the tech stack? (multiple choice based on codebase if detectable)
4. What are the main features for v1? (open-ended, then help them prioritize)
5. How should data be stored? (multiple choice)
6. Are there external integrations? (yes/no, then details)
7. What are the non-functional requirements? (performance, security, scale)
8. What constraints exist? (time, team size, infrastructure)
9-12. Domain-specific deep-dive questions based on earlier answers

### Phase 4: Approach Proposals

After gathering requirements, propose **2-3 approaches** with clear trade-offs:

```
## Approach A: [Name]
**Summary:** [1-2 sentences]
**Pros:** [bullet list]
**Cons:** [bullet list]
**Best when:** [scenario]
**Estimated complexity:** [simple/medium/complex]

## Approach B: [Name]
...

## Recommendation
I recommend **Approach [X]** because [reasoning].
```

Wait for the user to pick an approach (or ask for a hybrid). Do NOT proceed until they explicitly approve.

### Phase 5: Write Spec

Once the user approves an approach, write the spec file.

**Output location:** `.forge/specs/spec-{domain}.md`

The domain name should be a short, lowercase, hyphenated slug derived from the project topic (e.g., `auth`, `task-api`, `billing`, `notification-system`).

**Output format — use this template exactly:**

```markdown
---
domain: {domain}
status: approved
created: {YYYY-MM-DD}
complexity: {simple|medium|complex}
linked_repos: [{repo names if multi-repo, otherwise empty}]
---

# {Domain Title} Spec

## Overview
{Brief description of this domain, its purpose, and the chosen approach.}

## Requirements

### R001: {Requirement Name}
{Description of the requirement.}
**Acceptance Criteria:**
- [ ] {Specific, testable criterion 1}
- [ ] {Specific, testable criterion 2}
- [ ] {Specific, testable criterion 3}

### R002: {Next Requirement}
...
```

**Rules for writing requirements:**

1. **R-numbered sequentially** — R001, R002, R003...
2. **Each requirement gets a clear name** — not vague ("User Management"), not too specific ("Add username field to users table")
3. **Acceptance criteria are testable** — a developer can read each criterion and know exactly what to check. Bad: "Should work properly." Good: "POST /users returns 201 with {id, email, created_at} on success."
4. **Acceptance criteria are checkboxes** — they will be checked off during execution and verification
5. **Group related requirements** — keep them in logical order (data model first, then endpoints, then UI)
6. **Include error cases** — happy path AND failure scenarios
7. **Scope to v1** — if the user mentioned future features, note them in a "## Future Considerations" section but do NOT create requirements for them

### Phase 6: Multi-Domain Handling

If the project is complex and needs multiple specs:

1. Identify the domains (e.g., `auth`, `api`, `frontend`, `infra`)
2. Write a separate spec file for each domain
3. Cross-reference between specs where domains interact
4. Suggest an execution order (typically: data model -> backend -> frontend)

### Phase 7: Initialize Config

If `.forge/config.json` does not exist or needs updating:

1. Read the current config (or use defaults)
2. Update `repos` if multi-repo was discussed
3. Set `depth` based on detected complexity (simple->quick, medium->standard, complex->thorough)

### Phase 8: Next Steps

After writing all spec files, tell the user:

> Spec written to `.forge/specs/spec-{domain}.md` with {N} requirements.
>
> **Next step:** Run `/forge plan` to decompose these requirements into an ordered task frontier.

If multiple specs were written, list them all.

## Key Principles

- **One question at a time** — never overwhelm the user
- **Multiple choice preferred** — reduce cognitive load
- **YAGNI ruthlessly** — challenge unnecessary complexity
- **Always propose approaches** — never jump straight to writing the spec
- **Testable acceptance criteria** — every criterion must be verifiable by a developer or test
- **Scale to complexity** — simple projects get 3-5 questions, not 12
