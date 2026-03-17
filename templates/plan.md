---
spec: {{SPEC_NAME}}
total_tasks: {{N}}
estimated_tokens: {{TOTAL}}
depth: {{quick|standard|thorough}}
---

# {{SPEC_NAME}} Frontier

## Tier 1 (parallel — no dependencies)
- [T001] {{Task name}} | est: ~{{N}}k tokens | repo: {{REPO}}

## Tier 2 (depends on T001)
- [T002] {{Task name}} | est: ~{{N}}k tokens | repo: {{REPO}} | depends: T001
