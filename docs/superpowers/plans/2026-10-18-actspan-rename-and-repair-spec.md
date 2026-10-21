# Actspan Rename and Repair Spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate active Mole branding and runtime identifiers to Actspan without breaking legacy data migration, while recording the remaining repair contract in `docs/guide/actspan-repair-spec.md`.

**Architecture:** Active runtime identifiers, DOM contracts, CSS selectors, user-facing strings, release metadata, and docs move to Actspan in one coordinated cutover. Legacy storage keys, environment aliases, migration fixtures, and historical audit references remain read-only compatibility inputs. Generated output is rebuilt from source.

**Tech Stack:** TypeScript, React, Vite, Chrome MV3, Node ESM MCP server, Node test runner, VitePress.

**Spec:** `docs/guide/actspan-repair-spec.md`

## Global Constraints

- New runtime/UI/API names use `actspan` or `actspan_*`.
- Legacy `mole_*` storage/env keys remain read-only migration aliases only.
- Do not hand-edit `build_version/`; regenerate it from source.
- Do not alter historical migration evidence except to mark stale findings resolved.
- Every behavior change has a focused regression test before implementation.
- Do not run formatters, linters, or project-wide suites during individual tasks; run final verification once.

### Task 1: Lock the naming contract with regression checks

**Files:**
- Create: `src/actspan-branding.test.mjs`
- Test: `src/actspan-branding.test.mjs`

**Interfaces:**
- Consumes: source tree and generated extension output.
- Produces: deterministic checks that active output uses Actspan names while legacy aliases remain present only in migration/compatibility code.

- [x] **Step 1: Write failing checks**

Add Node tests that assert:

```js
assert.equal(source.includes("id = 'actspan-root'"), true);
assert.equal(source.includes("new CustomEvent('actspan-escape')"), true);
assert.equal(source.includes("mole_ai_settings"), true); // legacy migration contract
assert.equal(source.includes("actspan_ai_settings"), true); // canonical contract
```

Also assert the active React import graph no longer references `MoleRoot`, `MoleContext`, or `useMole`.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node --test src/actspan-branding.test.mjs`
Expected: FAIL because active source still contains Mole symbols and selectors.

- [x] **Step 3: Keep the checks narrow**

Limit the test to active source and the final build directory; explicitly exclude legacy fixtures and historical migration sections so the test does not force removal of compatibility inputs.

### Task 2: Rename active React symbols and files

**Files:**
- Rename: `src/content/float-ball/MoleRoot.tsx` → `src/content/float-ball/ActspanRoot.tsx`
- Rename: `src/content/float-ball/context/MoleContext.tsx` → `src/content/float-ball/context/ActspanContext.tsx`
- Rename: `src/content/float-ball/context/useMole.ts` → `src/content/float-ball/context/useActspan.ts`
- Modify: `src/content/float-ball/context/{types,reducer,context}.ts`
- Modify: all active float-ball components/hooks and `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/content/float-ball-react.tsx`

**Interfaces:**
- Consumes: existing reducer state/action shapes and component imports.
- Produces: `ActspanRoot`, `ActspanProvider`, `ActspanContext`, `ActspanContextValue`, `ActspanState`, `initialActspanState`, `actspanReducer`, and `useActspan` with unchanged runtime behavior.

- [x] **Step 1: Rename via symbol-aware file/symbol operations**

Use LSP `rename_file` for the three files when available, then LSP symbol rename for exported symbols and all references. Do not create compatibility aliases for active component names.

- [x] **Step 2: Run targeted TypeScript compilation**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no missing import or renamed symbol errors caused by this task.

### Task 3: Migrate active DOM, event, data, CSS, and user-facing identifiers

**Files:**
- Modify: `src/content/float-ball-react.tsx`, `src/content/float-ball.ts`
- Modify: `src/content/float-ball/styles.ts`, `src/content/sidepanel/sidepanel.css`, `src/options/components/FloatingChat.css`
- Modify: active float-ball components/hooks
- Modify: `src/content/page-grounding.ts`, `src/content/page-skeleton.ts`, `src/content/recorder-overlay.ts`
- Modify: `src/functions/cdp-dom.ts`, `src/functions/extract-data.ts`
- Modify: `src/functions/remote-workflow.ts`, `src/functions/webhook.ts`, `src/lib/console.ts`, `src/lib/storage.ts`, `src/config/index.ts`, `src/background.ts`, `src/content.ts`

**Interfaces:**
- Consumes: renamed React symbols from Task 2.
- Produces: one active DOM contract using `actspan-root`, `actspan-react-root`, `actspan-recorder-overlay`, `actspan-*` selectors/events/data attributes; legacy storage keys remain unchanged.

- [x] **Step 1: Add cross-module selector/event regression assertions**

Extend the focused test to assert every producer and consumer uses the same Actspan identifiers, including the DOM protection path in `cdp-dom.ts` and extraction exclusion in `extract-data.ts`.

- [x] **Step 2: Replace active identifiers only**

Replace active symbols, selectors, event names, comments, log labels, and webhook source markers. Do not replace literals declared as `LEGACY_*`, migration inputs, old environment aliases, compatibility fixtures, or historical spec evidence.

- [x] **Step 3: Run focused tests**

Run: `node --test src/actspan-branding.test.mjs src/lib/legacy-storage.test.mjs`
Expected: active naming checks pass and legacy migration checks remain green.

### Task 4: Update docs, package metadata, and release paths

**Files:**
- Modify: `README.md`, `README.en.md`, `MCP-BRIDGE.md`
- Modify: `docs/download.md`, `docs/en/download.md`
- Modify: `docs/guide/configuration.md`, `docs/en/guide/configuration.md`
- Modify: `docs/guide/development.md`, `docs/en/guide/development.md`
- Modify: `docs/.vitepress/config.ts`, `docs/release.data.ts`
- Modify: `.github/workflows/release.yml`, `package.json`
- Modify: `docs/guide/actspan-workflow-architecture-spec.md`

**Interfaces:**
- Consumes: active Actspan tool names and local MCP configuration contract.
- Produces: user-facing installation, release, tool, Feishu, and configuration docs consistent with source; historical/compatibility references explicitly retained only where required.

- [x] **Step 1: Update active docs and URLs**

Use `https://github.com/youxing-max/ActSpan`, `actspan-extension`, `actspan-mcp`, and the 34-tool stable inventory. Document `actspan_feishu_push` parameters and local-mode configuration.

- [x] **Step 2: Mark stale findings resolved**

In the architecture spec, mark remote source deletion and popup canonical registry shape as resolved, and add the repair spec link. Do not remove the historical evidence needed to explain migration.

- [x] **Step 3: Run documentation consistency checks**

Run targeted searches for old user-facing brand/path/tool strings and verify only migration/compatibility/history sections retain them.

### Task 5: Regenerate, verify, and review the cutover

**Files:**
- Modify: generated `build_version/actspan-extension/**` through the build only.
- Test: `src/actspan-branding.test.mjs`, affected existing tests.

**Interfaces:**
- Consumes: all source/doc changes from Tasks 2–4.
- Produces: reproducible Actspan build and evidence for the repair spec acceptance criteria.

- [x] **Step 1: Run the extension build**

Run: `npm run build`
Expected: all Vite builds pass and output remains under `build_version/actspan-extension/`.

- [x] **Step 2: Run focused behavioral tests**

Run: `node --test src/actspan-branding.test.mjs src/background/session-manager.test.mjs src/lib/legacy-storage.test.mjs src/functions/registry-service.test.mjs src/options/pages/actspan-console.test.mjs`
Expected: all affected tests pass, including Feishu completion fallback and canonical registry migration behavior.

- [x] **Step 3: Run MCP contract checks**

Run: `npm test`, `node --test test/security.mjs test/omp-compat.mjs`, and `node test/e2e.mjs` from `mcp-server/`.
Expected: catalog, tool inventory, Feishu forwarding, ownership, and authentication checks pass.

- [x] **Step 4: Perform reader and artifact review**

Read `docs/guide/actspan-repair-spec.md` without conversation context and verify each P0/P1 item has code evidence, a chosen behavior, and an observable acceptance test. Search the rebuilt output for active old branding; report only intentional compatibility/history hits.
