// scripts/forge-research-aggregator.cjs -- T014 / R005
//
// Append research sections to .forge/specs/<spec-id>.research.md.
//
// The brainstorming skill dispatches forge-researcher subagents in parallel
// (run_in_background) while the user answers later questions. Each subagent's
// output lands here, accumulating into a single file that the proposal stage
// reads and cites.
//
// Contract (R005 AC3, AC4):
//   - One file per spec: .forge/specs/<spec-id>.research.md
//   - YAML frontmatter: { spec, created, sections } -- sections count stays
//     in sync with the body.
//   - Each call appends a `## Section N: <heading>` block, then the body
//     text, then a `**Sources:**` bullet list.
//   - Duplicate headings get a ` (2)`, ` (3)`, ... suffix so every section is
//     addressable by a stable id (`#section-N-<slug>`).
//   - Section ordering is append-only and stable: section N always lands
//     after section N-1 and never reorders on re-read.
//
// The proposal stage cites findings via lines such as
//     per .forge/specs/<spec>.research.md#section-2-dagster
// so the slug must be deterministic from the heading.

const fs = require('fs');
const path = require('path');

// ---------- helpers ----------

function _specIdClean(specId) {
  if (!specId || typeof specId !== 'string') {
    throw new Error('appendResearchSection: specId is required (non-empty string)');
  }
  if (specId.includes('/') || specId.includes('\\') || specId.includes('..')) {
    throw new Error('appendResearchSection: specId must not contain path separators');
  }
  return specId;
}

function _researchFilePath(forgeDir, specId) {
  return path.join(forgeDir, 'specs', specId + '.research.md');
}

// Minimal local frontmatter parser -- keeps this module zero-dep and avoids
// a circular require against forge-tools.cjs.
function _parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, content: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const k = line.slice(0, sep).trim();
    let v = line.slice(sep + 1).trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
    data[k] = v;
  }
  return { data, content: m[2] };
}

function _serializeFrontmatter(data, content) {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${v}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n${content}`;
}

// Count existing `## Section N:` headings in the body so the next section gets
// the right ordinal. Also return a case-insensitive map of used headings so we
// can dedupe.
function _scanSections(body) {
  const lines = body.split('\n');
  let count = 0;
  const usedHeadings = new Map(); // normalised heading -> max suffix seen
  const re = /^## Section (\d+): (.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    count = Math.max(count, parseInt(m[1], 10));
    const full = m[2];
    // Strip trailing "(N)" suffix to get the base heading.
    const suffixMatch = full.match(/^(.*?)\s*\((\d+)\)\s*$/);
    const base = suffixMatch ? suffixMatch[1].trim() : full.trim();
    const suffix = suffixMatch ? parseInt(suffixMatch[2], 10) : 1;
    const key = base.toLowerCase();
    const prev = usedHeadings.get(key) || 0;
    if (suffix > prev) usedHeadings.set(key, suffix);
  }
  return { count, usedHeadings };
}

function _dedupeHeading(heading, usedHeadings) {
  const trimmed = String(heading).trim();
  if (!trimmed) throw new Error('appendResearchSection: heading is required');
  const key = trimmed.toLowerCase();
  const prev = usedHeadings.get(key);
  if (!prev) return trimmed;
  return `${trimmed} (${prev + 1})`;
}

function _normaliseSources(sources) {
  if (!sources) return [];
  if (!Array.isArray(sources)) {
    throw new Error('appendResearchSection: sources must be an array when provided');
  }
  return sources
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(Boolean);
}

function _renderSection(n, heading, body, sources) {
  const lines = [];
  lines.push(`## Section ${n}: ${heading}`);
  lines.push('');
  const trimmedBody = String(body == null ? '' : body).replace(/\s+$/, '');
  if (trimmedBody) {
    lines.push(trimmedBody);
    lines.push('');
  }
  if (sources.length) {
    lines.push('**Sources:**');
    for (const s of sources) lines.push(`- ${s}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- public API ----------

/**
 * Append a research section to `.forge/specs/<specId>.research.md`.
 *
 * Creates the file with YAML frontmatter on first call. Subsequent calls
 * append sections in stable order. Duplicate headings are suffixed `(2)`,
 * `(3)`, ... so every section id is unique.
 *
 * @param {string} forgeDir    Absolute or relative path to the .forge dir.
 * @param {string} specId      Spec identifier, e.g. "forge-v03-gaps".
 * @param {object} section     { heading: string, body: string, sources?: string[] }
 * @returns {{ path: string, section_number: number, heading: string, created: boolean }}
 */
function appendResearchSection(forgeDir, specId, section) {
  specId = _specIdClean(specId);
  if (!section || typeof section !== 'object') {
    throw new Error('appendResearchSection: section object is required');
  }
  const heading = section.heading;
  const body = section.body;
  const sources = _normaliseSources(section.sources);

  const filePath = _researchFilePath(forgeDir, specId);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let existing;
  let created = false;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    existing = null;
    created = true;
  }

  let data;
  let bodyContent;
  if (existing == null) {
    data = {
      spec: specId,
      created: new Date().toISOString().slice(0, 10),
      sections: 0
    };
    bodyContent = `# Research Notes for ${specId}\n\nAccumulating research dispatched by the brainstorming skill. Proposal stage cites specific sections below.\n\n`;
  } else {
    const parsed = _parseFrontmatter(existing);
    // Guard against callers deleting frontmatter: reconstruct if missing.
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      data = {
        spec: specId,
        created: new Date().toISOString().slice(0, 10),
        sections: 0
      };
      bodyContent = existing;
    } else {
      data = parsed.data;
      bodyContent = parsed.content;
    }
  }

  const { count, usedHeadings } = _scanSections(bodyContent);
  const nextN = count + 1;
  const finalHeading = _dedupeHeading(heading, usedHeadings);

  const rendered = _renderSection(nextN, finalHeading, body, sources);
  // Ensure a blank line before the new section if body is non-empty and does
  // not already end with one.
  let sep = '';
  if (bodyContent && !bodyContent.endsWith('\n\n')) {
    sep = bodyContent.endsWith('\n') ? '\n' : '\n\n';
  }

  const newBody = bodyContent + sep + rendered + '\n';
  data.sections = nextN;
  data.spec = specId; // always resync
  if (!data.created) data.created = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(filePath, _serializeFrontmatter(data, newBody));

  return {
    path: filePath,
    section_number: nextN,
    heading: finalHeading,
    created
  };
}

/**
 * Read the research file and return { data, sections: [{ n, heading, body, sources }] }.
 * Returns `null` if the file does not exist.
 */
function readResearchFile(forgeDir, specId) {
  specId = _specIdClean(specId);
  const filePath = _researchFilePath(forgeDir, specId);
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return null; }
  const parsed = _parseFrontmatter(text);
  const body = parsed.content;

  const sections = [];
  const re = /^## Section (\d+): (.+?)\s*$/;
  const lines = body.split('\n');
  let current = null;
  const flush = () => {
    if (!current) return;
    // Trim trailing blank lines on each block.
    current.body = current.bodyLines.join('\n').replace(/\s+$/, '');
    delete current.bodyLines;
    sections.push(current);
  };
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      flush();
      current = {
        n: parseInt(m[1], 10),
        heading: m[2].trim(),
        sources: [],
        bodyLines: []
      };
      continue;
    }
    if (!current) continue;
    // Sources block handling: collect bullets after `**Sources:**`
    if (/^\*\*Sources:\*\*\s*$/.test(line)) {
      current._inSources = true;
      continue;
    }
    if (current._inSources) {
      const sm = line.match(/^-\s+(.*)$/);
      if (sm) { current.sources.push(sm[1].trim()); continue; }
      if (line.trim() === '') continue;
      // Non-bullet non-blank line -> sources block ended.
      current._inSources = false;
    }
    current.bodyLines.push(line);
  }
  flush();
  return { path: filePath, data: parsed.data, sections };
}

module.exports = {
  appendResearchSection,
  readResearchFile,
  // exported for tests / introspection
  _researchFilePath,
  _scanSections,
  _dedupeHeading
};
