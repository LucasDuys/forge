// tests/mock-isolation.test.cjs -- T018 / R006
//
// Enforces that mock-projects/blurry-graph/ is a fully isolated test fixture.
// Covers spec-mock-and-visual-verify R006 acceptance criteria:
//
//   1. mock-projects/blurry-graph/ exists and has a package.json.
//   2. Mock package.json pins exact versions (no caret / tilde ranges) for
//      runtime deps: react, react-dom, d3, vite, @vitejs/plugin-react.
//   3. Mock .gitignore excludes node_modules/, dist/, .forge/baselines/.
//   4. No Forge source file under scripts/, agents/, hooks/, skills/, commands/
//      imports or requires from mock-projects/. Deleting the mock leaves the
//      Forge test suite intact (tests/ is explicitly allowed to reference the
//      mock as a fixture path, which is the intended integration surface).

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, runTests } = require('./_helper.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_ROOT = path.join(REPO_ROOT, 'mock-projects', 'blurry-graph');
const MOCK_PKG = path.join(MOCK_ROOT, 'package.json');
const MOCK_GITIGNORE = path.join(MOCK_ROOT, '.gitignore');

// Directories that are Forge's own runtime/source code. A reference to
// `mock-projects/` from any file under these paths would mean Forge depends
// on the mock existing, which violates R006 isolation.
const FORGE_SOURCE_DIRS = ['scripts', 'agents', 'hooks', 'skills', 'commands'];

// Pinned-version requirement: these runtime deps must resolve to a single
// concrete version (no caret, no tilde, no `latest`, no `*`, no ranges).
const PINNED_DEPS = ['react', 'react-dom', 'd3', 'vite', '@vitejs/plugin-react'];

// Required .gitignore entries (any order, comment-tolerant).
const REQUIRED_IGNORES = ['node_modules/', 'dist/', '.forge/baselines/'];

// Regexes for a forbidden `mock-projects/` import or require. We match
// string-literal references inside require(...) / import ... from "..." so
// plain comments mentioning the path do not trigger a false positive.
const REQUIRE_RE = /require\s*\(\s*['\"][^'\"]*mock-projects\//;
const IMPORT_RE = /(?:^|\s)import\s+[^'"`]*\s+from\s+['\"][^'\"]*mock-projects\/|import\s*\(\s*['\"][^'\"]*mock-projects\//;

function walkFiles(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, acc);
    } else if (entry.isFile()) {
      // Text-ish source files only. Avoid reading binaries.
      if (/\.(c?js|mjs|ts|tsx|jsx|sh|cjs)$/.test(entry.name)) {
        acc.push(full);
      }
    }
  }
  return acc;
}

function isPinnedVersion(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  // Reject any range / wildcard syntax. An exact version is digits and dots
  // with optional pre-release/build suffix (e.g. "1.2.3", "1.2.3-beta.1").
  if (/^[~^><=*]|\s-\s|\|\||latest|\s/.test(v)) return false;
  return /^\d+\.\d+\.\d+([.\-+][A-Za-z0-9.\-+]+)?$/.test(v);
}

suite('R006 -- mock project exists and has a package.json', () => {
  test('mock-projects/blurry-graph/ directory exists', () => {
    assert.ok(
      fs.existsSync(MOCK_ROOT) && fs.statSync(MOCK_ROOT).isDirectory(),
      `expected directory at ${MOCK_ROOT}`
    );
  });

  test('mock has its own package.json', () => {
    assert.ok(fs.existsSync(MOCK_PKG), `expected package.json at ${MOCK_PKG}`);
    const pkg = JSON.parse(fs.readFileSync(MOCK_PKG, 'utf8'));
    assert.strictEqual(pkg.name, 'blurry-graph');
  });
});

suite('R006 -- runtime deps are pinned (no caret / tilde ranges)', () => {
  test('react, react-dom, d3, vite, @vitejs/plugin-react are exact versions', () => {
    const pkg = JSON.parse(fs.readFileSync(MOCK_PKG, 'utf8'));
    const all = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    const unpinned = [];
    for (const dep of PINNED_DEPS) {
      const version = all[dep];
      if (version === undefined) {
        unpinned.push(`${dep} (missing)`);
        continue;
      }
      if (!isPinnedVersion(version)) {
        unpinned.push(`${dep}: ${version}`);
      }
    }
    assert.strictEqual(
      unpinned.length,
      0,
      `unpinned runtime deps: ${unpinned.join(', ')}`
    );
  });
});

suite('R006 -- mock .gitignore excludes node_modules, dist, .forge/baselines', () => {
  test('.gitignore file exists', () => {
    assert.ok(
      fs.existsSync(MOCK_GITIGNORE),
      `expected .gitignore at ${MOCK_GITIGNORE}`
    );
  });

  test('all three required entries are present', () => {
    const contents = fs.readFileSync(MOCK_GITIGNORE, 'utf8');
    const lines = contents
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const missing = REQUIRED_IGNORES.filter((needed) => !lines.includes(needed));
    assert.strictEqual(
      missing.length,
      0,
      `missing .gitignore entries: ${missing.join(', ')}`
    );
  });
});

suite('R006 -- no Forge source file imports from mock-projects/', () => {
  test('scripts/, agents/, hooks/, skills/, commands/ are clean', () => {
    const offenders = [];
    for (const sub of FORGE_SOURCE_DIRS) {
      const dir = path.join(REPO_ROOT, sub);
      const files = walkFiles(dir, []);
      for (const file of files) {
        const contents = fs.readFileSync(file, 'utf8');
        if (REQUIRE_RE.test(contents) || IMPORT_RE.test(contents)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    assert.strictEqual(
      offenders.length,
      0,
      `Forge source files import from mock-projects/: ${offenders.join(', ')}. ` +
        'The mock is a fixture — Forge runtime code must not depend on it.'
    );
  });

  test('deleting the mock directory would leave Forge source imports intact', () => {
    // Simulated delete: assert that no Forge source file (outside tests/) has
    // a path-resolved dependency on mock-projects/. This is the same invariant
    // as the previous test framed as "is the mock safe to rm -rf?". If this
    // passes, `rm -rf mock-projects/blurry-graph/` cannot break Forge itself.
    //
    // tests/ is deliberately excluded: tests consume the mock as a fixture
    // path (e.g. tests/spec-path-validation.test.cjs). That is the intended
    // integration surface per R006 AC3.
    const offenders = [];
    for (const sub of FORGE_SOURCE_DIRS) {
      const dir = path.join(REPO_ROOT, sub);
      const files = walkFiles(dir, []);
      for (const file of files) {
        const contents = fs.readFileSync(file, 'utf8');
        // Also catch plain fs.readFileSync('mock-projects/...') and similar
        // path-literal references that would hard-wire Forge to the mock.
        if (/['\"][^'\"]*mock-projects\/blurry-graph/.test(contents)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    assert.strictEqual(
      offenders.length,
      0,
      `Forge source files hard-reference mock-projects/blurry-graph/: ${offenders.join(', ')}`
    );
  });
});

runTests();
