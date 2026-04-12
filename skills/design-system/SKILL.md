---
name: design-system
description: DESIGN.md integration for Forge — ensures visual consistency across all UI tasks through standardized design specifications
---

# Design System Skill

This skill integrates DESIGN.md-based design specifications into the Forge workflow. When a project has a DESIGN.md file, all UI-related tasks automatically inherit design constraints, ensuring brand consistency across parallel agent execution.

## What is DESIGN.md?

DESIGN.md is a standardized markdown format for design specifications that AI agents can read and follow. It contains:

1. **Visual Theme and Atmosphere** -- brand philosophy and design mood
2. **Color Palette** -- semantic color definitions (Primary, Error, Surface, etc.) with hex values
3. **Typography Hierarchy** -- font families, weights, sizes for H1-H6, body, caption
4. **Component Styling** -- button specs, card styling, input borders, border radius, shadows
5. **Layout Principles and Spacing** -- spacing scale (base unit), margin/padding rules, grid conventions
6. **Depth and Elevation Systems** -- shadow definitions, z-index hierarchies
7. **Design Guardrails and Anti-Patterns** -- what NOT to do, brand identity boundaries
8. **Responsive Behavior Parameters** -- mobile/tablet/desktop breakpoints, scaling rules
9. **Agent Prompt Guide** -- quick reference for AI agents to maintain consistency

## Detection

At the start of brainstorming or planning, check for an existing DESIGN.md:

```bash
# Check common locations
ls DESIGN.md design.md docs/DESIGN.md 2>/dev/null
```

If found, load it and reference it throughout the workflow.

## Integration with Forge Phases

### Brainstorming Phase

When `/forge brainstorm` runs for a project with UI components:

1. **Check for DESIGN.md** -- if it exists, reference it during spec generation
2. **If no DESIGN.md exists**, ask the user during the Q&A phase:
   > Does this project have a design system or brand guidelines?
   > A) Yes, I have a DESIGN.md file (specify path)
   > B) I want to base it on an existing brand (specify which -- e.g., Stripe, Linear, Claude)
   > C) No specific design requirements -- use sensible defaults
   > D) I'll provide design specs later

3. **If option B**, generate a DESIGN.md by referencing the awesome-design-md catalog:
   - Extract the relevant design system's color palette, typography, and component specs
   - Adapt it for the user's project
   - Write to `DESIGN.md` in the project root
   - Include it in the spec's context

4. **Include design context in specs**: When writing spec files, add a `design` field in frontmatter:
   ```yaml
   ---
   domain: auth
   status: approved
   design: DESIGN.md
   ---
   ```

### Planning Phase

When `/forge plan` encounters specs with UI tasks:

1. **Load DESIGN.md** and extract key constraints (color palette, typography, spacing scale)
2. **Tag UI tasks** with design context in the frontier:
   ```
   - [T005] Login form component | est: ~6k tokens | design: DESIGN.md | depends: T003
   ```
3. **Group UI tasks by design community**: Components sharing design patterns (forms, cards, navigation) should be in the same tier when possible to ensure visual consistency
4. **Add design verification task** at the end of UI-heavy specs (depth >= standard):
   ```
   - [T012] Design consistency verification | est: ~4k tokens | depends: T005, T007, T009
   ```

### Execution Phase

When forge-executor handles a task tagged with `design:`:

1. **Load DESIGN.md** at task start, alongside the spec and frontier
2. **Extract relevant design tokens** for the task:
   - Color values for the component being built
   - Typography specs for text elements
   - Spacing values for layout
   - Component styling (border-radius, shadows, etc.)
3. **Apply design constraints** during implementation:
   - Use only colors defined in the palette (no ad-hoc hex values)
   - Follow the typography hierarchy (no custom font sizes)
   - Apply the spacing scale (no magic pixel values)
   - Match component styling specs (border-radius, shadows)
4. **Document design decisions** in the checkpoint context_bundle:
   ```json
   {"design_tokens": "primary=#1A73E8, radius=8px, spacing=8px-base"}
   ```

### Review Phase

When forge-reviewer reviews UI tasks with design context:

1. **Load DESIGN.md** alongside the spec
2. **Add a Design Compliance pass** after spec compliance:

   **Design Compliance Checks:**
   - Colors used in the implementation exist in the DESIGN.md palette
   - Font families and sizes match the typography hierarchy
   - Spacing values follow the defined scale (or multiples of the base unit)
   - Component styling matches specs (border-radius, shadows, elevation)
   - No ad-hoc design values that contradict the design system
   - Responsive breakpoints match DESIGN.md if specified

3. **Flag design violations:**
   - **IMPORTANT**: Color not in palette (e.g., used #FF0000 instead of defined Error color)
   - **IMPORTANT**: Font size not in typography scale
   - **MINOR**: Spacing value not a multiple of base unit
   - **MINOR**: Missing responsive behavior for a defined breakpoint

4. **Output format:**
   ```
   DESIGN COMPLIANCE:
   - [x] Colors: All colors from DESIGN.md palette
   - [ ] Typography: H2 uses 28px, DESIGN.md specifies 24px
   - [x] Spacing: All values multiples of 8px base
   - [x] Components: Border radius matches spec (8px)
   ```

## DESIGN.md Template

When generating a new DESIGN.md, use this structure:

```markdown
# DESIGN.md

## Visual Theme and Atmosphere
{Brand philosophy, mood, design direction}

## Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| Primary | #XXXXXX | Main interactive elements, CTAs |
| Primary Dark | #XXXXXX | Hover states, active elements |
| Secondary | #XXXXXX | Supporting UI, secondary actions |
| Accent | #XXXXXX | Highlights, badges, notifications |
| Background | #XXXXXX | Page background |
| Surface | #XXXXXX | Card/panel background |
| Error | #XXXXXX | Error states, destructive actions |
| Success | #XXXXXX | Success states, confirmations |
| Warning | #XXXXXX | Warning states |
| Text Primary | #XXXXXX | Main body text |
| Text Secondary | #XXXXXX | Supporting text, labels |
| Border | #XXXXXX | Dividers, input borders |

## Typography
| Level | Font | Size | Weight | Line Height |
|-------|------|------|--------|-------------|
| H1 | {font} | {size}px | 700 | {lh} |
| H2 | {font} | {size}px | 600 | {lh} |
| H3 | {font} | {size}px | 600 | {lh} |
| Body | {font} | {size}px | 400 | {lh} |
| Caption | {font} | {size}px | 400 | {lh} |
| Code | {mono font} | {size}px | 400 | {lh} |

## Component Styling
- **Button border-radius**: {N}px
- **Card border-radius**: {N}px
- **Input border-radius**: {N}px
- **Card shadow**: {shadow definition}
- **Elevated shadow**: {shadow definition}

## Spacing Scale
- **Base unit**: {N}px
- **Scale**: {N/2}, {N}, {N*1.5}, {N*2}, {N*3}, {N*4}, {N*6}, {N*8}

## Layout
- **Max content width**: {N}px
- **Grid columns**: {N}
- **Gutter**: {N}px

## Responsive Breakpoints
| Name | Min Width | Behavior |
|------|-----------|----------|
| Mobile | 0px | Single column, stacked layout |
| Tablet | {N}px | {behavior} |
| Desktop | {N}px | Full layout |

## Design Guardrails
- {Rule 1: what to avoid}
- {Rule 2: what to maintain}
- {Rule 3: brand boundaries}

## Agent Prompt Guide
When implementing UI for this project:
- Use only colors from the palette above
- Follow the typography hierarchy exactly
- Use spacing values from the scale (multiples of {base}px)
- Apply component styling specs for all interactive elements
```

## Graceful Degradation

When no DESIGN.md exists:
- Brainstorming proceeds normally, optionally asking about design requirements
- Planning proceeds without design tags on tasks
- Execution proceeds without design constraints
- Review skips the design compliance pass

No Forge workflow should ever fail because DESIGN.md is absent.
