# Forward and Reverse Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `manual inspect` with a recursive local import graph and generate `.manual/index/forward.json` plus `.manual/index/reverse.json`, while keeping capture and generate backward compatible.

**Architecture:** Page YAML remains the source of truth and gains a scan-owned `dependencies` block. A deterministic index builder derives both JSON indexes from page models; inspect refreshes dependencies, while describe and capture can rebuild indexes from stored dependencies. A tolerant index reader lets capture and generate consume the new context and fall back to the existing YAML path when indexes are absent or invalid.

**Tech Stack:** Node.js 18+, CommonJS, built-in `fs`/`path`, `js-yaml`, the repository's custom test runner.

---

### Task 1: Build the static import graph

**Files:**
- Create: `src/inspect/import-graph.js`
- Create: `test/import-graph.test.js`
- Modify: `test/run.js`

**Step 1: Write the failing direct and recursive import tests**

Create temporary source files with a page importing `LoginForm`, which imports `Input` and `useAuth`. Assert that the wished-for API returns stable project-relative paths and excludes the page entry itself:

```js
const { buildImportGraph } = require('../src/inspect/import-graph');

const result = buildImportGraph(root, 'src/app/login/page.tsx');
assert.deepStrictEqual(result.files, [
  'src/components/Input.tsx',
  'src/components/LoginForm.tsx',
  'src/hooks/useAuth.ts',
]);
assert.deepStrictEqual(result.unresolved, []);
```

Cover `import`, side-effect import, `export ... from`, and literal `require()` with real fixture files.

**Step 2: Run the test and verify RED**

Run: `node test/import-graph.test.js`

Expected: FAIL because `src/inspect/import-graph.js` does not exist.

**Step 3: Implement minimal specifier extraction and relative resolution**

Export:

```js
module.exports = {
  buildImportGraph,
  extractSpecifiers,
  resolveLocalImport,
};
```

Use lightweight lexical patterns limited to the V1 syntax, resolve supported source extensions and `index.*`, reject paths outside `projectRoot`, and normalize output with `replace(/\\/g, '/')`.

**Step 4: Run the focused test and verify GREEN**

Run: `node test/import-graph.test.js`

Expected: PASS for direct and recursive imports.

**Step 5: Add a failing cycle and ignored-resource test**

Create `A.ts → B.ts → A.ts`, plus imports of `react`, CSS, PNG, and a dynamic expression. Assert traversal terminates and ignored dependencies do not appear.

**Step 6: Run and verify RED**

Run: `node test/import-graph.test.js`

Expected: FAIL because cycle/resource filtering is incomplete.

**Step 7: Implement visited-set traversal and resource filtering**

Add a per-entry `Set` keyed by resolved absolute path and an explicit source extension allowlist. Do not follow bare package specifiers.

**Step 8: Run and verify GREEN**

Run: `node test/import-graph.test.js`

Expected: PASS with no hang and no external/static files.

**Step 9: Add a failing alias resolution test**

Write a `tsconfig.json` fixture with `baseUrl: "."` and `paths: { "@/*": ["src/*"] }`; assert `@/components/Input` resolves. Also assert an unmatched project-looking alias is listed in `unresolved` without throwing.

**Step 10: Run and verify RED**

Run: `node test/import-graph.test.js`

Expected: FAIL because aliases are not implemented.

**Step 11: Implement minimal `tsconfig.json` / `jsconfig.json` alias support**

Read the first available config, parse JSON/JSONC conservatively, expand one `*` capture in `paths`, then apply the same extension/index resolution. Treat unparseable config as no alias configuration.

**Step 12: Run and verify GREEN**

Run: `node test/import-graph.test.js`

Expected: PASS.

**Step 13: Commit**

When running in a Git worktree:

```bash
git add src/inspect/import-graph.js test/import-graph.test.js test/run.js
git commit -m "feat: build recursive page import graph"
```

Current workspace note: skip this step because `E:\NeoStar\user-manual` is not a Git repository.

### Task 2: Persist scan-owned dependencies in page models

**Files:**
- Modify: `src/inspect/model.js`
- Modify: `src/inspect/store.js`
- Modify: `src/commands/inspect.js`
- Modify: `test/inspect.test.js`

**Step 1: Write the failing model persistence test**

Enhance a Next.js fixture with real imports. Run inspect and assert `.manual/pages/login.yaml` contains:

```js
assert.deepStrictEqual(page.dependencies.files, [
  'src/components/Input.tsx',
  'src/components/LoginForm.tsx',
]);
assert.deepStrictEqual(page.dependencies.unresolved, []);
```

Also run inspect twice and assert the dependencies remain identical.

**Step 2: Run and verify RED**

Run: `node test/inspect.test.js`

Expected: FAIL because `dependencies` is not written.

**Step 3: Add the dependencies model field**

Update `createPage()` and `mergePage()` so dependencies are scan-owned and default to:

```js
{ files: [], unresolved: [] }
```

Before `reconcile()`, enrich every scanned page with `buildImportGraph(projectRoot, page.entry)`. Keep import warnings available for command output. Update `renderPageYaml()` to emit the new block in a fixed location after `source`.

**Step 4: Run and verify GREEN**

Run: `node test/inspect.test.js`

Expected: PASS for dependency persistence and all existing inspect cases.

**Step 5: Add a failing warning behavior test**

Assert an unreadable or unresolved local dependency appears in JSON output warnings while inspect exits successfully and writes the other pages.

**Step 6: Run and verify RED**

Run: `node test/inspect.test.js`

Expected: FAIL because dependency warnings are not exposed.

**Step 7: Implement non-fatal warnings**

Merge import graph warnings with configuration warnings in JSON and text output. Do not change the existing fatal behavior for malformed page YAML.

**Step 8: Run and verify GREEN**

Run: `node test/inspect.test.js`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/inspect/model.js src/inspect/store.js src/commands/inspect.js test/inspect.test.js
git commit -m "feat: persist page dependency metadata"
```

Skip in the current non-Git workspace.

### Task 3: Generate deterministic forward and reverse indexes

**Files:**
- Create: `src/inspect/index-builder.js`
- Create: `test/index-builder.test.js`
- Modify: `test/run.js`

**Step 1: Write the failing index shape test**

Pass two page models sharing `src/components/Input.tsx` to the wished-for builder:

```js
const { buildIndexes } = require('../src/inspect/index-builder');
const { forward, reverse } = buildIndexes(pages, { docsOutputDir: 'docs/manual' });

assert.deepStrictEqual(forward['/login'].entry, ['src/app/login/page.tsx']);
assert.deepStrictEqual(reverse['src/components/Input.tsx'], ['/login', '/settings']);
```

Assert `files` contains the entry plus dependencies; `components` and `hooks` are classified; `apis` and `scenarios` are empty; screenshot and manual fields are present.

**Step 2: Run and verify RED**

Run: `node test/index-builder.test.js`

Expected: FAIL because the module does not exist.

**Step 3: Implement the pure builders**

Implement `buildForwardIndex(pages, options)`, `buildReverseIndex(forward)`, and `buildIndexes(...)`. Include pages with `includeInManual: false` because code impact tracking is independent of publication; preserve the flag in forward entries. Normalize, de-duplicate, and sort every path and route list.

**Step 4: Run and verify GREEN**

Run: `node test/index-builder.test.js`

Expected: PASS.

**Step 5: Add a failing determinism test**

Feed pages and dependency arrays in different orders and assert `JSON.stringify()` output is byte-identical. Include Windows-style input paths.

**Step 6: Run and verify RED**

Run: `node test/index-builder.test.js`

Expected: FAIL until all keys and arrays are normalized and ordered.

**Step 7: Implement deterministic object construction**

Sort pages by route before assigning object keys, sort reverse keys before returning the object, and serialize using `JSON.stringify(value, null, 2) + '\n'`.

**Step 8: Run and verify GREEN**

Run: `node test/index-builder.test.js`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/inspect/index-builder.js test/index-builder.test.js test/run.js
git commit -m "feat: build deterministic manual indexes"
```

Skip in the current non-Git workspace.

### Task 4: Write and rebuild indexes from every page-model mutation

**Files:**
- Modify: `src/inspect/store.js`
- Modify: `src/commands/inspect.js`
- Modify: `src/commands/describe.js`
- Modify: `src/commands/capture.js`
- Modify: `test/inspect.test.js`
- Modify: `test/capture.test.js`

**Step 1: Write the failing inspect integration test**

After inspect, assert both files exist, parse as JSON, and match the expected forward/reverse mappings. Run inspect twice and assert their bytes are unchanged apart from no timestamp fields (the JSON indexes intentionally contain none).

**Step 2: Run and verify RED**

Run: `node test/inspect.test.js`

Expected: FAIL because `.manual/index/*.json` is absent.

**Step 3: Add index paths and writing to the store**

Add helpers:

```js
indexDirFor(stateDirAbs)
forwardIndexFileFor(stateDirAbs)
reverseIndexFileFor(stateDirAbs)
writeIndexes(stateDirAbs, pages, options)
```

Extend `writeModel(stateDirAbs, meta, pages, options)` to call `writeIndexes` when `options.docsOutputDir` is provided and return `indexFiles`. Update inspect, describe, and capture callers to pass `config.docs.outputDir`.

**Step 4: Run and verify GREEN**

Run: `node test/inspect.test.js`

Expected: PASS and writtenFiles includes both index paths.

**Step 5: Write the failing capture synchronization test**

After capture, assert `forward[route].screenshot` equals the newly written screenshot path. Preserve the existing assertion that `project.yaml` is updated.

**Step 6: Run and verify RED**

Run: `node test/capture.test.js`

Expected: FAIL because capture does not refresh indexes.

**Step 7: Pass index options from describe and capture**

Ensure every successful `store.writeModel()` invocation rebuilds indexes using existing page dependencies. Do not re-read source files outside inspect.

**Step 8: Run and verify GREEN**

Run: `node test/capture.test.js`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/inspect/store.js src/commands/inspect.js src/commands/describe.js src/commands/capture.js test/inspect.test.js test/capture.test.js
git commit -m "feat: write manual indexes with page model updates"
```

Skip in the current non-Git workspace.

### Task 5: Add a backward-compatible index reader

**Files:**
- Create: `src/inspect/index-store.js`
- Create: `test/index-store.test.js`
- Modify: `test/run.js`

**Step 1: Write the failing reader tests**

Cover a valid index, missing files, malformed JSON, and a route absent from the index. Desired API:

```js
const result = readIndexes(stateDirAbs);
assert.strictEqual(result.ok, true);
assert.deepStrictEqual(findForwardPage(result.forward, { id: 'login', route: '/login' }), expected);
```

For missing or malformed indexes, assert `{ ok: false, warning }` rather than an exception.

**Step 2: Run and verify RED**

Run: `node test/index-store.test.js`

Expected: FAIL because the reader does not exist.

**Step 3: Implement tolerant reading and lookup**

Validate that both parsed roots are plain objects. `findForwardPage` should prefer route, then scan by id. Never mutate the parsed data.

**Step 4: Run and verify GREEN**

Run: `node test/index-store.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/inspect/index-store.js test/index-store.test.js test/run.js
git commit -m "feat: read manual indexes with safe fallback"
```

Skip in the current non-Git workspace.

### Task 6: Make capture and generate consume index context

**Files:**
- Modify: `src/commands/capture.js`
- Modify: `src/commands/generate.js`
- Modify: `src/generate/draft.js`
- Modify: `test/capture.test.js`
- Modify: `test/generate.test.js`

**Step 1: Write the failing capture lookup test**

Create a fixture where the page YAML route is intentionally stale but the forward index has the current route. Assert capture uses the indexed route. Keep page YAML as the fallback and final persistence target.

**Step 2: Run and verify RED**

Run: `node test/capture.test.js`

Expected: FAIL because capture reads only `page.route`.

**Step 3: Use indexed route when available**

After loading the page YAML, read the indexes and obtain the matching forward entry. Use `indexed.route` only if the schema includes it; therefore add `route` explicitly inside every forward entry even though it is also the object key. Fall back silently to `page.route` when no valid entry exists.

**Step 4: Run and verify GREEN**

Run: `node test/capture.test.js`

Expected: PASS, including all existing failure classification tests.

**Step 5: Write the failing generate-context test**

Run draft generation with a valid index and assert the JSON command result contains an `indexContext` object with `entry`, `files`, `components`, `hooks`, `apis`, and `scenarios`. Assert the draft contains a metadata comment referencing the source files but does not add unverified user-facing instructions.

**Step 6: Run and verify RED**

Run: `node test/generate.test.js`

Expected: FAIL because index context is not returned or passed to the draft builder.

**Step 7: Add index context to generation**

Read the forward entry in `loadPage()` or `runDraft()`, pass it to `buildDraft()`, and emit only deterministic HTML metadata comments such as:

```md
<!-- 关联源码: src/app/login/page.tsx, src/components/LoginForm.tsx -->
```

Expose the same structured context in `--json` output for an AI caller. Do not change protected UI terms, route, steps, or screenshot facts.

**Step 8: Run and verify GREEN**

Run: `node test/generate.test.js`

Expected: PASS.

**Step 9: Write fallback regression tests**

Delete the index directory, then corrupt `forward.json`; in both cases assert capture and generate preserve their previous behavior using page YAML.

**Step 10: Run fallback tests and verify GREEN**

Run: `node test/capture.test.js`

Run: `node test/generate.test.js`

Expected: PASS with no uncaught JSON error.

**Step 11: Commit**

```bash
git add src/commands/capture.js src/commands/generate.js src/generate/draft.js test/capture.test.js test/generate.test.js
git commit -m "feat: consume page indexes in capture and generate"
```

Skip in the current non-Git workspace.

### Task 7: Update documentation and run full verification

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Update user-facing inspect documentation**

Document the two index files, the recursive local-import scope, warning behavior, and their use by capture/generate. State explicitly that JSON indexes are derived and should not be edited manually.

**Step 2: Update architecture ownership rules**

Add `dependencies` to inspect-owned page fields and describe the new data flow. Add API/props/runtime edges to non-goals or future versions.

**Step 3: Run focused tests**

Run: `node test/import-graph.test.js`

Run: `node test/index-builder.test.js`

Run: `node test/index-store.test.js`

Run: `npm run test:inspect`

Run: `npm run test:capture`

Run: `npm run test:generate`

Expected: all PASS with zero failures.

**Step 4: Run the full suite**

Run: `npm test`

Expected: all test files pass and the process exits 0.

**Step 5: Inspect generated artifacts manually**

Run inspect against a temporary Next.js fixture and verify:

- `.manual/index/forward.json` and `reverse.json` are valid UTF-8 JSON.
- Paths use `/` on Windows.
- Shared dependencies map to every affected route.
- Re-running inspect produces no JSON content changes.
- No business source files are modified.

**Step 6: Commit**

```bash
git add README.md SKILL.md docs/ARCHITECTURE.md
git commit -m "docs: document manual dependency indexes"
```

Skip in the current non-Git workspace.

## Execution environment

The repository was initialized before implementation. At the user's explicit request, the tasks were executed and committed directly on `main` instead of in a dedicated worktree. Every production change followed the documented RED/GREEN verification steps.
