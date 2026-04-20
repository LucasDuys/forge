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
| **Simple** (single feature, few files, clear scope) | Bug fix, small enhancement, single endpoint, UI tweak | 3-4 questions |
| **Medium** (multi-component, new feature with defined scope) | Multiple files across directories, needs tests, some cross-component work | 5-7 questions |
| **Complex** (multi-domain, architectural decisions, cross-repo) | New system/subsystem, security-sensitive, unfamiliar tech, multi-repo | Decompose into sub-projects first, then 5-7 questions per sub-project |

**Hard cadence bounds for every run:** minimum 3 questions, maximum 7 questions before the proposal stage. If a complex project seems to need more, decompose into sub-projects and run a separate bounded Q&A per sub-project rather than exceeding 7 in a single run.

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

Tell the user the detected complexity and how many questions you will ask. Example: "This looks like a **medium** complexity project. I'll ask 6 questions to nail down the spec, one at a time."

### CRITICAL: User Approval Gate

**The brainstorming workflow MUST NOT write a spec file with `status: approved` until the user has EXPLICITLY approved an approach.** This is the primary enforcement mechanism that prevents the Forge pipeline from being bypassed.

The approval gate works as follows:
1. You MUST ask clarifying questions (Phase 3) before proposing approaches
2. You MUST present 2-3 approaches with trade-offs (Phase 4)
3. You MUST wait for the user to explicitly say which approach they want
4. Only AFTER explicit user approval do you write the spec with `status: approved`

**What counts as explicit approval:**
- User says "go with A", "I pick approach B", "yes, do that", "approved", "let's go with the second one"
- User modifies an approach and says "do this version"

**What does NOT count as approval:**
- User provides no response (do NOT assume approval from silence)
- User asks a follow-up question (answer it, then re-ask for approval)
- Agent decides an approach is "obvious" (still must present options and wait)
- User's original prompt seems to imply a preference (still must confirm explicitly)

**If the user tries to skip brainstorming** (e.g., "just do it", "skip the questions"), respond:
> The Forge workflow requires a spec with approved requirements before implementation. This prevents wasted work and scope creep. I'll keep the questions brief -- let me ask the most critical ones.

Then ask at minimum 3 questions before proposing approaches.

### Phase 2: Handle Special Modes

#### --from-code mode
1. Use Glob and Grep to scan the project structure
2. Read key files (package.json, config files, main entry points, CLAUDE.md)
3. Identify the tech stack, architecture patterns, existing conventions
4. Generate an initial spec draft based on what you find
5. Present the draft to the user and **ask 3-5 clarifying questions, one at a time, using the Phase 3 cadence (summarize each answer in two sentences or fewer before asking the next)**. Never exceed 7 questions total.
6. Proceed to Phase 4 (approach proposals) with the refined spec -- do NOT skip the approval gate

#### --from-docs mode
1. Read all files from the specified PATH (markdown, text, PDF, CSV)
2. Extract requirements, user stories, acceptance criteria from the documents
3. Organize into domains and R-numbered requirements
4. Present the extracted spec to the user for validation
5. **Ask 3-5 clarifying questions, one at a time, using the Phase 3 cadence (summarize each answer in two sentences or fewer before asking the next)** for any ambiguous requirements. Never exceed 7 questions total.
6. Proceed to Phase 4 (approach proposals) with the refined spec -- do NOT skip the approval gate

### Phase 3: Interactive Q&A

**Rules — follow these strictly:**

1. **Exactly one question per prompt.** Send one question. Send nothing else alongside it. Then wait for the user's answer before doing anything else.
2. **Summarize each answer in two sentences or fewer, then ask the next question.** After the user replies, the next message you send has this shape and only this shape:
   - A one- or two-sentence summary starting with "Captured:" that restates what you heard and what it implies for the spec.
   - A blank line.
   - The next single question.
   The summary proves you understood before you move on, and it gives the user a chance to correct you if you misheard.
3. **Minimum 3, maximum 7 questions before the proposal stage.** Do not exceed 7 questions in a single run. If you think the project needs more, you have mis-scoped it — decompose into sub-projects (Phase 6) and run a bounded Q&A per sub-project instead.
4. **Multiple choice preferred.** When options are knowable in advance, present 2-4 choices. Example:
   > How should authentication work?
   > A) JWT tokens (stateless, good for APIs)
   > B) Session cookies (simpler, good for web apps)
   > C) OAuth2 with external provider (Google, GitHub, etc.)
   > D) Something else (describe)
5. **YAGNI ruthlessly.** If a feature sounds like premature optimization or speculative, gently push back. "Do you need that for v1, or can we add it later?"
6. **Start broad, narrow down.** First questions establish scope and architecture. Later questions refine details.
7. **Adapt to answers.** If the user's answers reveal the project is simpler (or more complex) than initially detected, adjust the remaining question count — but never exceed the hard ceiling of 7.

**Correct pattern — one question, then summarize, then next:**

> Assistant (Q1):
> What is the core problem this solves?
>
> User: Our support team has no way to see which customers opened a support email.
>
> Assistant (Q2):
> Captured: the goal is tracking email opens for support-sent messages so the team sees who engaged. That implies per-message tracking tied to a customer id.
>
> Who will read this data?
> A) Only support agents in their dashboard
> B) Support agents plus sales
> C) Everyone in the company
> D) Something else

**Anti-pattern — DO NOT do this:**

> Assistant (DO NOT do this):
> Great idea. To get started, tell me:
> 1) What is the core problem this solves?
> 2) Who are the users?
> 3) What's the tech stack?
> 4) What are the main features for v1?
> 5) How should data be stored?

Batching questions lets the user skim or skip. It also wastes context, because the user often answers only the easy ones and leaves the architecturally important ones blank. Always send one question, wait, summarize, then send the next.

**Question progression for a typical project** (pick the first 3-7 that matter for the detected complexity):

1. What is the core problem this solves? (open-ended)
2. Who are the users? (multiple choice if obvious categories exist)
3. What's the tech stack? (multiple choice based on codebase if detectable)
4. What are the main features for v1? (open-ended, then help them prioritize)
5. How should data be stored? (multiple choice)
6. Are there external integrations? (yes/no, then details)
7. What are the non-functional requirements? (performance, security, scale)

Stop at or before 7. If you still feel blocked on design decisions, that is a signal to propose approaches in Phase 4 with the ambiguity called out as a trade-off, not to keep asking.

**For projects with UI components, add a design system question:**
> Does this project have a design system or brand guidelines?
> A) Yes, I have a DESIGN.md file (specify path)
> B) I want to base it on an existing brand (e.g., Stripe, Linear, Claude)
> C) No specific design requirements -- use sensible defaults
> D) I'll provide design specs later

If option B, generate a DESIGN.md using the template from `skills/design-system/SKILL.md` and write it to the project root. Reference the awesome-design-md catalog (github.com/VoltAgent/awesome-design-md) for established brand design systems.

### Phase 3.4: Parallel research dispatch

While the user is still answering questions 3 through 7, the skill should fire **forge-researcher** subagents in the background so that by the time Phase 4 (approach proposals) starts, 1-2 research artefacts are already on disk and can be cited directly in the trade-off table.

**Config gate.** Read `.forge/config.json`. If `brainstorm.web_search_enabled` is `false`, skip this entire phase and add a one-line note to the spec's Future Considerations section: `Research dispatch disabled (brainstorm.web_search_enabled=false).` The default when the flag is missing is `true`.

**When to dispatch.**

| Trigger | Prompt shape |
|--------|--------------|
| Immediately after question 2 is answered | `find 3 prior-art approaches to <topic derived from Q1+Q2 answers> and summarise tradeoffs` |
| Immediately after question 4 is answered (only if the run reaches Q4) | narrower follow-up using Q3+Q4 answers, e.g. `for <approach family from Q3>, compare <specific constraint from Q4> across the 3 candidates found previously` |

Do NOT dispatch after questions 5-7; by then you should be converging on the proposal, not widening research.

**How to dispatch.**

1. Determine the active spec id from `.forge/state.md` frontmatter (`spec:` field) or, if no spec file exists yet, from the domain slug you intend to write in Phase 5.
2. Call the Agent tool with:
   - `subagent_type: "forge-researcher"` (or `"forge:forge-researcher"` when the plugin namespace is required)
   - `run_in_background: true`
   - A prompt following the shape above, with the user's actual answers inlined.
3. When the subagent returns, capture its structured report and persist the relevant section by calling:
   ```bash
   node scripts/forge-tools.cjs research-append \
     --spec <spec-id> \
     --heading "<short heading — e.g. 'Dagster asset graph'>" \
     --body-file <tempfile with the research markdown> \
     --sources "<comma-separated URLs or doc refs>"
   ```
   The file lands at `.forge/specs/<spec-id>.research.md` with YAML frontmatter and `## Section N: <heading>` blocks. Duplicate headings get a `(2)`, `(3)`, ... suffix automatically.

**Proposal-stage citations.** When you present Phase 4 approaches, every non-obvious trade-off claim MUST cite a specific research section by path, e.g.:
> Approach B builds on the Dagster-style asset graph — per `.forge/specs/forge-v03-gaps.research.md#section-1-dagster-asset-graph`, the key trade-off is worker-level AC tracking vs frontier-level.

Or when quoting pre-existing research under `docs/audit/research/`:
> per `docs/audit/research/streaming-dag.md#dagster`

If no research file exists (flag disabled, Agent tool unavailable, or every dispatch failed), add an explicit note at the top of the Phase 4 proposal block: `Note: no research file available -- approaches below are drawn from the Q&A only.` This is a required disclosure, not a silent skip.

**Fallback paths.**

- **Agent tool not available in this runtime.** Proceed to Phase 4 without dispatch. Log the absence to `.forge/state.md` under `## decisions` (e.g. `brainstorm: research dispatch skipped, Agent tool missing`).
- **Dispatch succeeds but subagent errors or returns empty.** Treat as "no section for this dispatch". Do NOT retry; the goal is fresh context for the proposal stage, not perfect research.
- **`brainstorm.web_search_enabled: false`.** Skip both dispatches. The spec's Future Considerations must contain the disabled-flag note described above.

The whole phase is best-effort: brainstorming never blocks on research. If the user is already on question 6 before the first subagent returns, mention the pending research in your Captured summary and continue.

### Phase 3.5: Knowledge Graph Context (if available)

If `graphify-out/graph.json` exists, load it before proposing approaches:
1. Query god nodes to understand core architectural concepts
2. Query community structure to identify module boundaries
3. Use this context to propose approaches that align with existing architecture
4. Reference specific modules and dependencies in approach proposals

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
design: {path to DESIGN.md if UI project, otherwise omit}
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

- **Exactly one question per prompt** — never overwhelm or let the user skim
- **Summarize each answer in two sentences or fewer before the next question** — proves understanding and invites correction
- **Minimum 3, maximum 7 questions before the proposal stage** — decompose into sub-projects if you need more
- **Multiple choice preferred** — reduce cognitive load
- **YAGNI ruthlessly** — challenge unnecessary complexity
- **Always propose approaches** — never jump straight to writing the spec
- **Testable acceptance criteria** — every criterion must be verifiable by a developer or test
- **Scale to complexity** — simple projects get 3-4 questions, medium 5-7, complex decomposes first
