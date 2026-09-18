# Auth Cache and Precise Privacy Redaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reusable named browser authentication profiles and replace broad black-box masking with policy-driven, text-level, irreversible neutral mosaic redaction for public manuals.

**Architecture:** Keep authentication secrets in a user-level cache keyed by project and profile, while project YAML stores only stable references and privacy policy. Load and refresh Playwright storage state through a small session boundary, then split privacy work into pure detection and geometry modules plus browser-side DOM measurement/rendering. Preserve the existing raw → sanitized → annotated publication pipeline and fail closed only for unresolved high-risk content.

**Tech Stack:** Node.js 18 CommonJS, Playwright, js-yaml, built-in `node:crypto`/`node:fs`, existing dependency-free test runner.

---

Before implementation, create a dedicated `codex/` worktree and use @test-driven-development for each task. Do not copy `preserved-from-neoagent-worktree-2026-09-18/` into commits.

### Task 1: Add backward-compatible auth and privacy configuration

**Files:**
- Modify: `src/config/schema.js`
- Modify: `src/config/render.js`
- Modify: `src/config/load.js`
- Modify: `src/commands/init.js`
- Modify: `test/init.test.js`
- Modify: `SKILL.md`

**Step 1: Write the failing configuration tests**

Add assertions to `test/init.test.js` for the default configuration and two new cases:

```js
assert.deepStrictEqual(c.privacy, {
  audience: 'public',
  redaction: 'balanced',
  maskStyle: 'neutral-mosaic',
  rules: { redact: [], preserve: [] },
});
assert.strictEqual(c.auth.enabled, true);
assert.strictEqual(c.auth.activeProfile, 'default');
assert.match(c.auth.cacheKey, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
assert.strictEqual(c.auth.loginUrl, '/login');
assert.strictEqual(c.auth.verifyPath, null);
```

Add a test that `--audience internal` is persisted and a bad value is rejected:

```js
test('--audience internal 写入内部发布策略', (root) => {
  const r = runInit(root, ['--base-url', 'https://app.example.com', '--audience', 'internal']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readConfig(root).privacy.audience, 'internal');
});

test('拒绝未知 audience', (root) => {
  const r = runInit(root, ['--base-url', 'https://app.example.com', '--audience', 'partner']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--audience/);
});
```

Add a direct `loadConfig()` compatibility test using a legacy YAML without `auth` or `privacy`; assert the loader supplies the defaults without changing `version: 1`.

**Step 2: Run the test and verify it fails**

Run: `node test/init.test.js`

Expected: FAIL because `privacy`, `auth`, and `--audience` are not implemented.

**Step 3: Implement schema defaults and validation**

In `src/config/schema.js`, add:

```js
const crypto = require('crypto');
const AUDIENCES = ['public', 'internal'];

function deriveCacheKey(name, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const suffix = crypto.createHash('sha256').update(origin).digest('hex').slice(0, 8);
  return `${name}-${suffix}`.slice(0, 64);
}

function validateAudience(raw, errors) {
  const value = String(raw || 'public');
  if (!AUDIENCES.includes(value)) {
    errors.push(`--audience 只支持 public/internal，收到: ${value}`);
    return null;
  }
  return value;
}
```

Build these optional blocks without increasing `CONFIG_VERSION`:

```js
privacy: {
  audience,
  redaction: 'balanced',
  maskStyle: 'neutral-mosaic',
  rules: { redact: [], preserve: [] },
},
auth: {
  enabled: true,
  cacheKey: deriveCacheKey(name, baseUrl),
  activeProfile: 'default',
  loginUrl: '/login',
  verifyPath: null,
},
```

Update `loadConfig()` to deep-merge these defaults so legacy configuration remains valid. Validate `auth.cacheKey` and `auth.activeProfile` with the same safe-name character class used for project names, and validate `privacy.rules.redact/preserve` as arrays.

Add `audience` to `KNOWN_FLAGS`, HELP, `buildConfig()` input, JSON output, and human summary. Render commented `privacy` and `auth` sections in `renderConfigYaml()`.

**Step 4: Update the Skill initialization questions**

Change `SKILL.md` from five to six initialization questions. Add “发布范围” with `public` as the default and document `--audience public|internal`. Explain that `manual auth login` is run only when a protected page needs an authenticated profile.

**Step 5: Run the focused tests**

Run: `node test/init.test.js`

Expected: all init tests pass, including legacy configuration loading.

**Step 6: Commit**

```bash
git add src/config/schema.js src/config/render.js src/config/load.js src/commands/init.js test/init.test.js SKILL.md
git commit -m "✨【功能】：新增认证与隐私策略配置"
```

### Task 2: Implement the user-level authentication cache

**Files:**
- Create: `src/auth/cache.js`
- Create: `test/auth-cache.test.js`
- Modify: `test/run.js`

**Step 1: Write cache-path and persistence tests**

Create `test/auth-cache.test.js` with a temporary cache root injected through function options, not through the real user directory. Cover:

```js
const cache = require('../src/auth/cache');

const file = cache.cacheFileFor({
  root: tempRoot,
  cacheKey: 'neoagent-test',
  profile: 'teacher',
});
assert.strictEqual(file, path.join(tempRoot, 'neoagent-test', 'teacher.state.json'));

cache.writeState({ root: tempRoot, cacheKey: 'neoagent-test', profile: 'teacher' }, {
  origin: 'https://example.com',
  storageState: { cookies: [{ name: 'sid', value: 'secret' }], origins: [] },
});
assert.deepStrictEqual(
  cache.readState({ root: tempRoot, cacheKey: 'neoagent-test', profile: 'teacher' }).storageState.cookies[0].name,
  'sid'
);
```

Also test:

- traversal names such as `../escape` are rejected;
- a truncated JSON file returns `auth-corrupt` without including its contents;
- an injected rename failure leaves the previous valid file intact;
- `clearState()` removes only the selected profile;
- `publicMetadata()` returns timestamps and origin but no cookie/localStorage values.

**Step 2: Run the test and verify it fails**

Run: `node test/auth-cache.test.js`

Expected: FAIL with `Cannot find module '../src/auth/cache'`.

**Step 3: Implement the cache module**

Export this narrow API:

```js
module.exports = {
  defaultCacheRoot,
  cacheFileFor,
  readState,
  writeState,
  clearState,
  publicMetadata,
  validateSafeName,
};
```

`defaultCacheRoot()` should use `%LOCALAPPDATA%/living-user-manual/auth` on Windows and `os.homedir()/.cache/living-user-manual/auth` elsewhere. Never use the project root. Persist this envelope:

```js
{
  version: 1,
  cacheKey,
  profile,
  origin,
  updatedAt: new Date().toISOString(),
  storageState,
}
```

Write to a sibling temporary file opened with mode `0o600`, `fsync`, then rename over the destination. Error objects may include the file path and reason code, but never file contents or parsed storage state.

**Step 4: Register and run the test**

Add `auth-cache.test.js` to `test/run.js` immediately after `init.test.js`.

Run: `node test/auth-cache.test.js`

Expected: all cache tests pass.

**Step 5: Commit**

```bash
git add src/auth/cache.js test/auth-cache.test.js test/run.js
git commit -m "✨【功能】：实现用户级认证状态缓存"
```

### Task 3: Teach the Playwright provider to import and export storage state

**Files:**
- Modify: `src/browser/provider.js`
- Modify: `src/browser/index.js`
- Modify: `src/browser/playwright.js`
- Create: `test/auth-session.test.js`
- Modify: `test/run.js`

**Step 1: Write provider/session contract tests**

Use a fake provider in `test/auth-session.test.js` to define the contract:

```js
class FakeProvider {
  constructor() { this.imported = null; }
  async setStorageState(value) { this.imported = value; }
  async exportStorageState() { return { cookies: [], origins: [] }; }
}
```

For the real provider factory, assert `createProvider({ ..., storageState })` preserves the state until launch. Add an integration case against `test/server.js` in which an HTTP-only cookie and localStorage key are set, exported, then loaded into a second context and observed by the protected page.

**Step 2: Run the test and verify it fails**

Run: `node test/auth-session.test.js`

Expected: FAIL because the provider cannot receive or export storage state.

**Step 3: Extend the provider contract**

Pass `storageState` through `createProvider()` and `BrowserProvider` construction. In `PlaywrightBrowserProvider.launch()` add it to `browser.newContext()` only when present:

```js
this.context = await this.browser.newContext({
  ...contextOptions,
  ...(this.storageState ? { storageState: this.storageState } : {}),
});
```

Add:

```js
async exportStorageState() {
  if (!this.context) throw new Error('exportStorageState 之前必须先 launch()。');
  return this.context.storageState();
}
```

Add a default `exportStorageState()` returning `null` to the abstract provider so non-Playwright adapters remain compatible.

**Step 4: Run the focused tests**

Run: `node test/auth-session.test.js`

Expected: cookie and localStorage survive context recreation; no secret is printed.

**Step 5: Commit**

```bash
git add src/browser/provider.js src/browser/index.js src/browser/playwright.js test/auth-session.test.js test/run.js test/server.js
git commit -m "✨【功能】：支持浏览器认证状态导入导出"
```

### Task 4: Add `manual auth login/status/clear`

**Files:**
- Create: `src/auth/session.js`
- Create: `src/commands/auth.js`
- Modify: `bin/manual.js`
- Create: `test/auth-command.test.js`
- Modify: `test/run.js`

**Step 1: Write command and session tests**

Test the pure session orchestration with a fake provider. A successful login must:

```js
const result = await establishSession({
  provider,
  loginUrl: 'https://example.com/login',
  verifyUrl: 'https://example.com/user-center',
  timeout: 300000,
});
assert.strictEqual(result.ok, true);
assert.deepStrictEqual(result.storageState, { cookies: [], origins: [] });
```

The fake provider should expose `waitForAuthentication({ loginUrl, verifyUrl, timeout })`; simulate success, timeout, and a final URL that still matches the login-path expression.

Spawn CLI tests for:

- `manual auth status --json` with no cache returns `{ok:true,status:'missing'}` without failing;
- `manual auth clear --profile teacher --json` removes only that profile;
- unknown auth action exits with code 1;
- JSON output never contains a seeded cookie value.

Use an injectable `MANUAL_AUTH_CACHE_DIR` only in spawned test processes so tests never touch the real user cache.

**Step 2: Run the test and verify it fails**

Run: `node test/auth-command.test.js`

Expected: FAIL because `auth` is an unknown command.

**Step 3: Implement the auth command**

Register one top-level `auth` command in `bin/manual.js`; parse `login|status|clear` as its first positional argument. Support:

```text
manual auth login [--profile <name>] [--login-url <url>] [--verify-path <path>] [--timeout <ms>]
manual auth status [--profile <name>] [--json]
manual auth clear [--profile <name>] [--json]
```

`status` returns only `missing|ready|corrupt`, origin, profile, cache path and timestamps. `clear` is idempotent.

`login` must force a headed Playwright provider, open the configured login URL, wait until navigation leaves the login route, then open the optional verification URL. Only after verification succeeds may it call `exportStorageState()` and `writeState()`.

Add `waitForAuthentication()` to `PlaywrightBrowserProvider`. It may poll URL and page facts at a short interval, but it must use Playwright waits rather than a shell sleep. Timeout errors must contain recovery guidance and no page storage.

**Step 4: Run focused tests**

Run: `node test/auth-command.test.js`

Expected: all command tests pass.

**Step 5: Commit**

```bash
git add src/auth/session.js src/commands/auth.js src/browser/playwright.js bin/manual.js test/auth-command.test.js test/run.js
git commit -m "✨【功能】：新增认证档案管理命令"
```

### Task 5: Reuse and refresh authentication in capture flows

**Files:**
- Create: `src/auth/runtime.js`
- Modify: `src/commands/capture.js`
- Modify: `src/commands/capture-task.js`
- Modify: `src/tasks/executor.js`
- Modify: `src/browser/errors.js`
- Modify: `test/capture.test.js`
- Modify: `test/task-executor.test.js`

**Step 1: Write failing integration tests**

Extend `test/server.js` with a protected route accepting either an HTTP-only session cookie or a localStorage bearer token. Add capture tests that seed a temporary auth cache and spawn with `MANUAL_AUTH_CACHE_DIR`:

```js
assert.strictEqual(result.status, 0, result.stderr);
assert.ok(fs.existsSync(expectedScreenshot));
assert.ok(readState(cacheRef).updatedAt >= seeded.updatedAt);
```

Add failure cases:

- no cache + redirect to login → `auth-missing` and `manual auth login --profile default` hint;
- existing cache + redirect to login → `auth-expired`;
- corrupt cache → `auth-corrupt` before browser launch;
- a public page succeeds with no cache;
- output does not contain the seeded secret.

Add an executor unit test ensuring task capture exports refreshed state only after successful completion.

**Step 2: Run the tests and verify they fail**

Run: `node test/capture.test.js`

Run: `node test/task-executor.test.js`

Expected: protected capture remains `login-required`, and no state is refreshed.

**Step 3: Implement shared auth runtime**

Expose:

```js
prepareAuth(config, options) -> { ref, storageState, status }
classifyAuthFailure(error, authStatus, profile) -> CaptureError
refreshAuth(provider, ref, expectedOrigin) -> { updated, warning }
```

Both capture commands must use this boundary. Pass loaded `storageState` into `createProvider()`. If `assessOutcome()` detects a login redirect, translate it to `auth-missing` or `auth-expired`. After a successful authenticated capture, export and atomically update the same profile. A refresh error becomes a warning and does not delete the prior file.

`executeCapturePlan()` should accept callbacks or an `authRuntime` object rather than importing global paths directly, keeping executor tests deterministic.

**Step 4: Run focused tests**

Run: `node test/capture.test.js`

Run: `node test/task-executor.test.js`

Expected: all old and new capture cases pass.

**Step 5: Commit**

```bash
git add src/auth/runtime.js src/commands/capture.js src/commands/capture-task.js src/tasks/executor.js src/browser/errors.js test/capture.test.js test/task-executor.test.js test/server.js
git commit -m "✨【功能】：截图流程复用并刷新认证缓存"
```

### Task 6: Replace broad redaction with policy-driven detection

**Files:**
- Create: `src/privacy/detector.js`
- Modify: `src/artifacts/redaction.js`
- Modify: `src/tasks/executor.js`
- Modify: `test/artifacts.test.js`

**Step 1: Replace the old behavior assertions**

Update `test/artifacts.test.js` so public ambiguous fields are masked instead of blocking, already-obscured values are preserved, and high-risk rules override ordinary preserve:

```js
const publicResult = detectRedactions([
  candidate('星海中学', '学校'),
  candidate('134****1255', '联系电话'),
  candidate('secret-token', 'access_token', { type: 'password' }),
], publicPolicy);

assert.strictEqual(publicResult.ok, true);
assert.deepStrictEqual(publicResult.redactions.map((x) => x.kind), ['semantic', 'credential']);
assert.ok(!JSON.stringify(publicResult).includes('星海中学'));
assert.ok(!JSON.stringify(publicResult).includes('secret-token'));
```

Add cases for full phone, email, account/UID label, explicit selector rule, scoped page rule, `internal` preservation, and redact/preserve conflicts.

**Step 2: Run the test and verify it fails**

Run: `node test/artifacts.test.js`

Expected: FAIL because ambiguous fields currently block and masked phone values are not recognized.

**Step 3: Implement the detector**

Make `src/privacy/detector.js` pure and export:

```js
module.exports = {
  detectRedactions,
  classifyCandidate,
  isAlreadyObscured,
  normalizePolicy,
};
```

Candidates carry facts but the returned redactions must omit `text`:

```js
{
  text,
  label,
  rect,
  pagePath,
  selectorHint,
  inputType,
  source, // explicit | form-control | text-pattern
}
```

Return only `{kind, rect, source, confidence, result:'neutral-mosaic'}`. Keep `src/artifacts/redaction.js` as a compatibility facade exporting `planRedactions()` and delegating to the new detector.

**Step 4: Run the focused test**

Run: `node test/artifacts.test.js`

Expected: all policy tests pass and serialized results contain no original values.

**Step 5: Commit**

```bash
git add src/privacy/detector.js src/artifacts/redaction.js src/tasks/executor.js test/artifacts.test.js
git commit -m "♻️【重构】：按发布策略识别隐私内容"
```

### Task 7: Measure text-level geometry and render irreversible neutral mosaic

**Files:**
- Create: `src/privacy/geometry.js`
- Create: `src/privacy/renderer.js`
- Modify: `src/browser/playwright.js`
- Modify: `test/artifacts.test.js`
- Modify: `test/task-first-e2e.test.js`

**Step 1: Write pure geometry tests**

Test viewport clipping, zero-area removal, duplicate removal and adjacent-fragment merging:

```js
assert.deepStrictEqual(
  normalizeRects([{ x: -5, y: 10, width: 20, height: 10 }], { width: 100, height: 100 }),
  [{ x: 0, y: 10, width: 15, height: 10 }]
);
```

Add Playwright-backed cases to `task-first-e2e.test.js` for:

- a text node whose mask width is smaller than its parent card;
- an input whose mask does not cover its border;
- DPR 2 output with CSS-pixel manifest coordinates;
- a scrolled page whose overlay remains aligned;
- overlapping candidates producing one visible mask.

**Step 2: Run tests and verify they fail**

Run: `node test/artifacts.test.js`

Run: `node test/task-first-e2e.test.js`

Expected: FAIL because current input masks use the full control rectangle and result is `opaque-mask`.

**Step 3: Implement geometry normalization**

`src/privacy/geometry.js` should export `clipRect`, `dedupeRects`, `mergeTextFragments`, and `normalizeRects`. Use a small fixed epsilon for floating-point equality; never merge unrelated candidates merely because their boxes touch.

In the page-evaluated collector:

- use `Range.selectNodeContents()` for leaf text nodes;
- for input/textarea values, derive the content box from computed border/padding and cap height to computed line-height;
- use the full element box only for explicit element-level redaction;
- return CSS viewport coordinates and the input/source facts required by the detector;
- skip invisible and zero-area boxes.

**Step 4: Implement the renderer**

Make `src/privacy/renderer.js` return safe CSS for `neutral-mosaic`:

```js
function neutralMosaicStyle(rect, theme) {
  return [
    'position:absolute',
    `left:${rect.x}px`, `top:${rect.y}px`,
    `width:${Math.max(rect.width, 24)}px`, `height:${rect.height}px`,
    `background-color:${theme.base}`,
    `background-image:repeating-conic-gradient(${theme.cellA} 0 25%, ${theme.cellB} 0 50%)`,
    `background-size:${theme.cellSize}px ${theme.cellSize}px`,
    `border-radius:${theme.radius}px`,
  ].join(';');
}
```

The base must be fully opaque and the pattern must not sample underlying pixels. Add the mask style and theme fields to the config renderer/loader only if Task 1 did not already include the needed defaults.

Update `renderEvidence()` to use the renderer output and set manifest result to `neutral-mosaic`.

**Step 5: Run focused tests and inspect the fixture image**

Run: `node test/artifacts.test.js`

Run: `node test/task-first-e2e.test.js`

Expected: tests pass; fixture output shows intact control borders with only value text covered by a light synthetic mosaic.

**Step 6: Commit**

```bash
git add src/privacy/geometry.js src/privacy/renderer.js src/browser/playwright.js src/config/load.js src/config/render.js test/artifacts.test.js test/task-first-e2e.test.js
git commit -m "✨【功能】：实现文字级不可逆浅色马赛克"
```

### Task 8: Enforce public publication boundaries

**Files:**
- Create: `src/privacy/publication.js`
- Modify: `src/commands/verify.js`
- Modify: `src/generate/task-facts.js`
- Modify: `test/generate-task.test.js`
- Modify: `test/artifacts.test.js`

**Step 1: Write failing publication tests**

Cover these cases:

```js
assert.strictEqual(validatePublishedImages(['docs/manual/images/annotated/a.png'], publicConfig).ok, true);
assert.strictEqual(validatePublishedImages(['.manual/artifacts/raw/a.png'], publicConfig).ok, false);
assert.strictEqual(validatePublishedImages(['.manual/artifacts/sanitized/a.png'], publicConfig).ok, false);
assert.strictEqual(validateEvidence({ unresolvedHighRisk: 1 }, publicConfig).ok, false);
assert.strictEqual(validateEvidence({ maskStyle: 'blur' }, publicConfig).ok, false);
```

Also assert diagnostic paths and auth-cache paths cannot appear in facts or final Markdown.

**Step 2: Run tests and verify they fail**

Run: `node test/generate-task.test.js`

Run: `node test/artifacts.test.js`

Expected: at least blur style and high-risk unresolved cases are not rejected yet.

**Step 3: Implement and wire the publication validator**

Export `validatePublishedImages()` and `validateEvidence()` from `src/privacy/publication.js`. Call them while building task facts and again in `manual verify`; defense in depth is intentional because facts files may be edited or stale.

For `privacy.audience === 'public'` require:

- every image path is below configured `artifacts.annotatedDir`;
- every referenced evidence screenshot records a safe mask style;
- no unresolved high-risk candidate exists;
- no path points into the user auth cache or `.manual/artifacts/{raw,sanitized,diagnostics}`.

Do not embed candidate text in validation errors.

**Step 4: Run focused tests**

Run: `node test/generate-task.test.js`

Run: `node test/artifacts.test.js`

Expected: all publication boundary tests pass.

**Step 5: Commit**

```bash
git add src/privacy/publication.js src/commands/verify.js src/generate/task-facts.js test/generate-task.test.js test/artifacts.test.js
git commit -m "🔒【安全】：收紧公开手册发布边界"
```

### Task 9: Update documentation and run full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `SKILL.md`
- Modify: `test/compat-aliases.test.js`

**Step 1: Add documentation checks where practical**

Extend `test/compat-aliases.test.js` or add a small documentation assertion ensuring generated aliases still direct clients to the main Skill, which now documents `manual auth` and the sixth init question.

**Step 2: Update documentation**

Document:

- the public/internal init choice;
- `manual auth login/status/clear` examples;
- user-level cache location and the fact that it is shared across worktrees;
- how to switch named profiles;
- `auth-missing`, `auth-expired`, and `auth-corrupt` recovery;
- the high-confidence/semantic/already-obscured privacy rules;
- why public manuals use synthetic opaque mosaic rather than blur;
- the revised Provider methods and privacy component boundaries.

Remove the architecture backlog statement claiming login state is unimplemented. Clarify that `.manual/session/` is no longer the credential store; if retained, it may contain only non-secret project metadata.

**Step 3: Run targeted command help checks**

Run: `node bin/manual.js init --help`

Expected: help includes `--audience`.

Run: `node bin/manual.js auth --help`

Expected: help lists `login`, `status`, and `clear` without exposing a cache value.

**Step 4: Run the complete test suite**

Run: `npm test`

Expected: every test file passes.

**Step 5: Run repository hygiene checks**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only intended source, test and documentation changes are present; `preserved-from-neoagent-worktree-2026-09-18/` remains untracked and unstaged.

**Step 6: Perform final review**

Use @requesting-code-review, then apply @verification-before-completion before claiming the feature is finished. Specifically inspect all JSON/error paths for accidental cookie, token, localStorage value, or raw candidate text disclosure.

**Step 7: Commit**

```bash
git add README.md docs/ARCHITECTURE.md SKILL.md test/compat-aliases.test.js
git commit -m "📝【文档】：说明认证缓存与公开脱敏流程"
```

## Completion criteria

- A user logs in once with `manual auth login` and subsequent page/task captures reuse that state across worktrees.
- Named profiles are isolated and can be inspected or cleared without exposing credentials.
- Missing, expired and corrupt auth states have classified, actionable errors.
- Public initialization records `privacy.audience: public`.
- Published screenshots mask only sensitive content, preserve surrounding UI, and use irreversible neutral mosaic rather than black rectangles or blur.
- No auth value or sensitive candidate text appears in CLI output, manifests, diagnostics metadata or committed documentation.
- Existing projects without new config keys and public pages without authentication keep working.
- `npm test` and `git diff --check` pass.
