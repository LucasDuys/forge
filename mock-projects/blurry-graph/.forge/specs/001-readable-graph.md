---
domain: readable-graph
status: approved
created: 2026-04-20
complexity: standard
linked_repos: []
supersedes: []
relates_to: ../../../../docs/superpowers/specs/spec-mock-and-visual-verify.md
---

# Readable Graph Spec (Mock Fixture)

## Overview

This spec lives inside the `blurry-graph` mock fixture and is the input the Forge visual-verifier consumes when the end-to-end harness (spec-mock-and-visual-verify R003) runs `/forge:execute` against this project.

The fixture ships three deliberate regressions (halo overlay, random zoom-out, empty synthesis panel) toggled by flags in `src/config.ts`. The acceptance criteria below — a mix of perceptual `[visual]` checks handled by the Playwright-driven verifier and structural DOM assertions handled by the standard verifier — encode what a "good" rendering looks like. An autonomous Forge run should see each AC fail on the broken state, fix the underlying regression, and observe the ACs flip to pass.

The extended AC syntax used here (`[visual] path=... viewport=... checks=[...]`) is defined in `docs/superpowers/specs/spec-forge-v03-gaps.md` R007.

## Requirements

### R001: Readable nodes

Nodes must render at a size where their labels are legible, without overlapping halo effects bleeding into neighbouring nodes, and with enough text contrast to pass WCAG AA.

**Acceptance Criteria:**
- [ ] [visual] path=/ viewport=1280x800 checks=["node labels are readable", "no halo rings overlap adjacent nodes", "text contrast passes WCAG AA"]
- [ ] [structural] assert node label text content matches data.nodes[i].label for every node

### R002: Sensible initial zoom

On mount the graph should fill the viewport with reasonable padding, at a scale that keeps nodes visible, and centered within 10% of the viewport centre. This must hold at both the default 1280x800 developer viewport and the 1920x1080 presentation viewport.

**Acceptance Criteria:**
- [ ] [visual] path=/ viewport=1280x800 checks=["graph fills viewport with reasonable padding", "scale is not near-zero", "graph is centered within 10% of viewport center"]
- [ ] [visual] path=/ viewport=1920x1080 checks=["graph fills viewport with reasonable padding", "scale is not near-zero", "graph is centered within 10% of viewport center"]

### R003: Synthesis panel populated

The right-side synthesis panel must show two populated sections — Agreed and Disputed — drawn from the node graph, with real node text rather than empty bullets.

**Acceptance Criteria:**
- [ ] [visual] path=/ checks=["synthesis panel shows Agreed section", "synthesis panel shows Disputed section", "sections contain node text, not empty bullets"]
- [ ] [structural] document.querySelectorAll('[data-testid=synthesis] h3').length === 2
