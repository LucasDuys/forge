# Brainstorming Skill — Manual Test Protocol

This is a scripted, human-run protocol that exercises the one-question-at-a-time cadence mandated by spec R004 in `docs/superpowers/specs/spec-forge-v03-gaps.md`. Run it whenever `skills/brainstorming/SKILL.md` changes, or when you suspect an agent has regressed the cadence.

## How to run

1. Open a fresh Claude Code session in a repo that has `.forge/` initialized.
2. Invoke `/forge:brainstorm` with the topic line below. Play the role of the mock user. Answer verbatim.
3. At each step, check the "Expected behaviour" column. If the agent deviates, the test fails and you must capture the deviation in the failure log at the bottom of this file.

## Mock scenario

- **Topic the user sends:** `a lightweight internal tool that lets support agents see which customers opened our outbound support emails`
- **Expected complexity detection:** medium (score around 4-5: multi-component, needs tests, possibly cross-component tracking + dashboard).
- **Expected question count:** 5 questions (inside the 3-7 bound).

## Scripted run

| Step | Mock user input | Expected agent behaviour |
|------|-----------------|--------------------------|
| 0 | `/forge:brainstorm a lightweight internal tool ...` (full topic above) | Agent runs setup, discover, then prints complexity detection ("medium, I'll ask about 5 questions, one at a time") and immediately sends Q1. Q1 is ONE question. No numbered list of five questions. No "I will also ask X, Y, Z". |
| 1 (Q1) | `Our support team has no way to see which customers opened a support email — we email a lot and have no feedback loop.` | Agent's next message starts with `Captured:` and is one or two sentences summarising what it heard, followed by a blank line, then exactly ONE question (Q2). No Q3 yet. No multi-bullet question. |
| 2 (Q2) | `Only support agents in their dashboard. Sales has its own system.` | Agent's next message: `Captured:` summary (<= 2 sentences), blank line, then exactly ONE question (Q3). |
| 3 (Q3) | `Node backend, Postgres, React frontend. Same stack as our existing internal tools.` | Agent's next message: `Captured:` summary (<= 2 sentences), blank line, then exactly ONE question (Q4). Agent may reference the detected stack but still asks only one thing. |
| 4 (Q4) | `For v1: see a list of sent emails with open/not-open status per recipient. No analytics, no A/B testing.` | Agent's next message: `Captured:` summary (<= 2 sentences) that also acknowledges the YAGNI cut (no analytics), blank line, then exactly ONE question (Q5). |
| 5 (Q5) | `We use SendGrid already; open-tracking pixel is on by default. Webhooks land in a queue we control.` | Agent's next message: `Captured:` summary (<= 2 sentences), then it should STOP asking questions (we are at 5, inside the 3-7 bound and covering enough ground) and transition to Phase 4 (Approach Proposals). It MUST NOT ask a 6th or 7th question just because the ceiling allows it. |
| 6 | (no user input — agent continues on its own after Q5 summary) | Agent presents 2-3 approaches in the Phase 4 format with Pros/Cons/Recommendation, then waits for approval. Agent does NOT write `.forge/specs/spec-*.md` yet. |
| 7 | `go with approach A` (or whichever it recommends) | Only now does the agent write the spec file with `status: approved`. |

## Pass criteria

- Every agent message from step 1 through step 5 contains exactly one question. Count question marks in the user-facing prompt — must be 1, not 2+.
- Every agent message from step 2 through step 5 begins with `Captured:` followed by a summary of 2 sentences or fewer (count sentence-ending periods; must be <= 2).
- Total questions before Phase 4 is between 3 and 7 inclusive. For this scripted scenario, 5 is expected.
- At no point does the agent batch multiple questions in a single prompt (the anti-pattern).
- Phase 4 (approach proposals) appears before any spec file is written.
- Spec file is written only after step 7 (explicit approval).

## Fail modes to watch for

- Agent sends a numbered list of questions in a single message at step 0 or step 1 -> FAIL (anti-pattern).
- Agent skips the `Captured:` summary on any step -> FAIL (R004 AC1).
- Agent summary runs 3+ sentences -> FAIL (R004 AC1, "two sentences or fewer").
- Agent asks a Q6 or Q7 when Q5 already covered enough ground -> soft FAIL (violates "stop when enough is gathered" guidance, even though the ceiling is 7).
- Agent asks Q8+ -> hard FAIL (violates R004 AC2 max 7).
- Agent writes `status: approved` spec before step 7 -> hard FAIL (violates the approval gate, orthogonal to R004 but part of Phase 3 integrity).

## Failure log

When a run fails, append an entry here with date, which step failed, and the exact agent output that violated the expected behaviour. Keep the log append-only so regressions are visible over time.

```
<!-- Example entry template -->
<!--
### YYYY-MM-DD run
- Step failed: 3
- Expected: one question after Captured summary
- Actual: agent asked three questions in bullet list
- Agent output excerpt:
  > Captured: you want Node/Postgres/React.
  > 1) ...
  > 2) ...
  > 3) ...
-->
```
