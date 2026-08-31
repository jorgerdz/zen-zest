# Zen Organizer — MVP Implementation Plan

**Source:** [Implementation specification](./spec.md)  
**Status:** Ready to execute  
**Mode:** MVP, plain modules, no speculative infrastructure

## 1. Delivery outcome

Ship a Sine mod that reads the complete live Zen tab hierarchy, supports local triage and reviewed bulk plans, and applies approved changes through Zen's live APIs. AI planning is optional; the organizer remains fully useful with the provider set to `none`.

The MVP is done only when a disposable-profile test proves that 50 tabs can be moved through one reviewed plan, the result survives restart, no tab is lost, and no metadata leaves Zen before consent.

## 2. Fixed implementation decisions

These decisions resolve the spec's open or permissive areas so implementation does not branch unnecessarily.

| Area | MVP decision |
|---|---|
| Runtime | Sine mod using browser-native HTML, CSS, JavaScript modules, and `fetch`. |
| Dependencies | None unless the compatibility spike proves Sine requires one. |
| State | Zen is authoritative. Persist one versioned JSON settings/draft object only. |
| Zen access | All private API and Zen DOM access lives in `zen-adapter.mjs`. |
| UI | One full-page manager. Render all rows first; add virtualization only if the 500-row target fails. |
| Validation | Hand-written strict validation for the small fixed schema; reject unknown fields and types. |
| Errors | Use the fixed error codes from spec section 17 and plain result objects; do not add an error-class hierarchy. |
| Apply failure | Stop on the first failed tab/action, report exact successes and failures, and mark everything remaining `not_run`. Do not add rollback in v1. |
| Drift | Refresh and revalidate before apply. Any revision change makes the plan stale and requires another review and approval. |
| Closes | Manual plans only, executed last, with a second confirmation. Reject model-generated closes. |
| Redirects | Use `redirect: "manual"` and reject redirects. This is simpler and safer than cross-origin re-consent. |
| Tokens | Use Firefox Login Manager if the spike verifies it. Otherwise keep the token in memory and show the limitation. |
| HTTP | Allow HTTP for loopback; warn and require consent for private LAN; require HTTPS elsewhere. |
| Generic planner API | Defer `/v1/plan`; Ollama and OpenAI-compatible modes satisfy v1. |
| Undo plan | Defer. Zen undo-close remains the recovery path for separately confirmed closes. |
| Framework/build/database/server | Do not add them. Revisit only after a measured or user-validated need. |

## 3. Minimal file plan

Add files only in the phase that first needs them:

```text
docs/
  spec.md
  implementation-plan.md
  spike-results.md          # Phase 0 evidence
organizer.uc.mjs            # lifecycle and UI wiring
zen-adapter.mjs             # the only Zen-private boundary
organizer-core.mjs          # pure snapshot, search, suggestions, and plan logic
organizer.html
organizer.css
providers.mjs               # Phase 4 only
tests/
  core.test.mjs             # native node:test; fake Zen objects stay here initially
README.md                    # Phase 5
LICENSE                      # Phase 5
```

Add Sine metadata files only after Phase 0 confirms their required names and fields. Do not add `package.json` unless a real command requires it; tests can run with `node --test` directly.

## 4. Phase 0 — Blocking Zen compatibility spike

### Goal

Replace every guessed private API with observed methods from the minimum supported Zen build in a disposable profile.

### Implementation steps

1. Create a disposable Zen profile and record the exact Zen, Firefox, Sine, and OS versions in `docs/spike-results.md`.
2. Inspect the installed Zen source and runtime objects for `gZenWorkspaces`, `gZenFolders`, `gBrowser`, session restoration, and Sine lifecycle hooks.
3. Record exact method signatures and object/DOM attributes for:
   - session-ready detection;
   - all Spaces and stored tabs, including inactive Spaces;
   - nested Folders and membership;
   - stable tab IDs, Essentials, pins, containers, selection, and Split Views;
   - Folder creation, nesting, rename, tab insertion, and removal;
   - moving tabs between Spaces;
   - pin/unpin and close.
4. Exercise create Folder, move between Spaces, move into/out of Folder, rename, pin/unpin, and close against test tabs only.
5. Restart Zen and verify that every successful mutation persisted and undo-close recovered the closed tab.
6. Verify the least brittle way for Sine to register and open a full-page organizer.
7. Probe Firefox Login Manager availability from the mod context without storing a real token.
8. Write a capability table with `supported`, `unsupported`, and the observed API evidence. Keep throwaway spike code out of the product modules.

### Required check

- [x] All nine spike operations in spec section 8 have evidence.
- [x] No profile/session file was written directly.
- [x] Full-page registration is known.
- [x] Secure-token capability is known.

### Outcome resolution

- **Full pass:** implement the read/write MVP using the observed calls.
- **Folder mutation missing:** continue through Phase 2 as a read-only prototype; disable mutation UI and do not claim the write MVP is complete.
- **Read-all-Spaces missing:** stop the product implementation and document the incompatibility; a partial inventory does not satisfy the product.
- **Login Manager missing:** continue with session-memory tokens.
- **Full-page registration missing:** stop and document the Sine blocker; do not replace the manager with a popup.
- **Any mutation is only possible through profile-file edits:** mark it unsupported and fail closed.

## 5. Phase 1 — Read-only inventory

### Goal

Open the organizer and accurately display all supported live Zen state with no mutation or network path.

### Implementation steps

1. Create the Sine entry point and full-page HTML/CSS shell using the lifecycle verified in Phase 0.
2. Implement `zen-adapter.mjs` feature detection and session-ready waiting.
3. Normalize live objects into the exact `Snapshot` schema from the spec:
   - preserve IDs as opaque strings;
   - exclude placeholder, empty, and Glance-only structural tabs;
   - mark an unstable tab ID as ephemeral;
   - expose capability flags instead of assuming methods exist.
4. In `organizer-core.mjs`, validate/index the snapshot and compute its SHA-256 revision from the canonical sorted identity/location fields. Use native `crypto.subtle` in Zen.
5. Render the Space/Folder tree and these views: all tabs, ungrouped, individual Space, and individual Folder.
6. Add title/hostname/Space/Folder search; required filters; required sorts; select-all for the filtered result; and summary counts.
7. Render 500 rows normally and measure first. Keep selection and keyboard focus stable across filter/sort changes.
8. Show a clear read-only compatibility state whenever required mutation capabilities are missing.
9. Add native `node:test` checks for normalization, hierarchy, exclusion rules, stable/ephemeral IDs, revision stability, search, filters, and summaries. Inject Web Crypto in the test environment rather than adding a hashing package.

### Required check

```sh
node --test tests/core.test.mjs
```

- [x] A disposable restored profile shows every expected Space, nested Folder, and real tab.
- [x] The same logical snapshot produces the same revision regardless of enumeration order.
- [x] No network request or mutation can be triggered.
- [x] Snapshot plus first render stays under two seconds for 500 tabs/100 Folders.
- [x] Search/filter response stays under 100 ms.

### Outcome resolution

- **Pass:** continue with the existing snapshot and UI; they become the base for all later phases.
- **Bad inventory:** fix normalization in the adapter once, not individual views.
- **Slow row rendering:** identify the measured bottleneck; add simple windowing only if DOM rendering causes the miss.
- **Private API unavailable:** expose the capability error and remain read-only.

## 6. Phase 2 — Local triage and editable plans

### Goal

Let users understand clutter and build a complete plan without changing Zen.

### Implementation steps

1. Add exact duplicate detection with native `URL` normalization:
   - remove fragments;
   - preserve query strings;
   - group exact normalized URLs;
   - rank the keep candidate by Essential, pinned, selected, then most recent access;
   - never create an automatic close operation.
2. Add inactivity buckets for ungrouped tabs at 30+, 90+, and 180+ days, labeled as last-selection time.
3. Add duplicate and inactivity views plus Space/Folder summary counts.
4. Implement the fixed `Plan`/`Operation` schema and strict validation:
   - exact allowed properties per operation;
   - real, unique, stable IDs only;
   - capabilities and Folder depth checked;
   - `folderRef` must point to an earlier create operation;
   - maximum 500 operations and 1,000 referenced tabs;
   - Folder names trimmed and bounded by the spike result;
   - Essentials excluded from generated plans unless explicitly enabled.
5. Add manual actions for create/rename Folder, move selected tabs, set pinned state, and stage close.
6. Add plan review showing before/after location. Allow removing a tab, removing an operation, and changing its destination before apply.
7. Implement the required execution ordering as pure logic, without calling the adapter.
8. Persist only the draft plan inside the one versioned organizer settings object. Mark it stale after restart until revalidated.
9. Extend `core.test.mjs` for duplicates, inactivity, schema rejection, limits, Folder references, Essentials, ordering, and plan editing.

### Required check

```sh
node --test tests/core.test.mjs
```

- [x] A user can select 50 filtered tabs and stage a move.
- [x] Folder creation and a move into its `folderRef` can exist in one plan.
- [x] Unknown properties/types/IDs and ephemeral IDs are rejected.
- [x] Duplicate suggestions do not mutate or auto-close anything.
- [x] Editing or deleting review items produces a valid plan.

### Outcome resolution

- **Pass:** the reviewed plan is the only input accepted by the executor.
- **Invalid manual edit:** keep the draft visible, mark the exact error, and disable Apply.
- **Unsupported capability:** prevent staging that operation and explain the missing capability.
- **Uncertain duplicate URL:** omit it from the duplicate group; false negatives are safer than false positives.

## 7. Phase 3 — Preflight and approved live apply

### Goal

Safely execute a reviewed manual/deterministic plan and report the exact resulting state.

### Implementation steps

1. Add desired-state adapter methods for create/rename Folder, move to Space, move to/from Folder, set pinned, and close. Each method must return success if the requested state already exists.
2. Resolve every normalized ID back to the current live object immediately before its action. Never retain stale Zen object references from snapshot capture.
3. Implement Apply as this fixed flow:
   1. require an explicit review approval;
   2. refresh the snapshot and revision;
   3. if drifted, revalidate, mark stale, show the drift, and return without mutation;
   4. create Folders and resolve `folderRef`s;
   5. rename Folders;
   6. move tabs to Spaces, then into Folders;
   7. set pinned state;
   8. request a separate confirmation and run closes last;
   9. refresh inventory and show results.
4. Execute multi-tab operations one tab at a time so partial results identify exact tab IDs. Stop at the first failure and mark all remaining actions `not_run`.
5. Store only the last structured apply result needed for recovery/support. Redact titles, hosts, prompts, URLs, and tokens from logs.
6. On close, verify the target again, exclude Essentials unless explicitly included in this manual plan, then use Zen's live close API.
7. Add fake-Zen tests for desired-state no-ops, missing capabilities/IDs, drift, Folder references, exact partial results, stop-on-failure, and close-last ordering.
8. Run the disposable-profile scenario: create a Folder, move 50 tabs, restart, and verify every tab and destination.

### Required check

```sh
node --test tests/core.test.mjs
```

- [x] No adapter mutation method is reachable before approval and preflight.
- [x] Any revision drift performs zero mutations and requires reapproval.
- [x] Reapplying completed desired-state operations is harmless.
- [x] A forced failure reports exact completed/failed/not-run actions.
- [x] Confirmed closes run last and are recoverable with Zen undo-close.
- [x] No code writes Zen profile/session files.

### Outcome resolution

- **Pass:** manual organization is release-capable.
- **Drift:** preserve the draft, show validation changes, and require review against the new revision.
- **Action failure:** stop, refresh, show exact results, and let desired-state validation build a new plan for remaining work.
- **Tab disappears:** report `TAB_NOT_FOUND`; never substitute a URL/title match.
- **Folder creation fails:** mark dependent actions `not_run` and stop.
- **Close recovery fails in the spike/profile test:** disable close operations for release.

## 8. Phase 4 — Optional provider planning

### Goal

Generate untrusted editable plans from Ollama and OpenAI-compatible endpoints without expanding provider authority.

### Implementation steps

1. Add `providers.mjs` with `none`, `ollama`, and `openai-compatible` modes. It may return data to core validation but may never import or call the Zen adapter.
2. Build the exact safe provider projection locally. Default to title, hostname, hierarchy names, pinned/Essential state, and coarse last-accessed days; exclude URL paths, queries, fragments, content, container names, and local/private hosts.
3. Show the exact outbound JSON before the first request. Store consent by normalized provider origin and disclosure options; require consent again when either changes.
4. Validate provider URLs with native `URL` and enforce the HTTP policy. Allow non-loopback HTTP only for RFC1918 IP literals or `.local` hosts after the LAN warning; reject other public HTTP, embedded credentials, and all redirects.
5. Use native `fetch`, `AbortController` for the 60-second timeout, and a bounded response reader for the 1 MB response limit. Reject default payloads over 512 KB.
6. Implement Ollama structured output and `/v1/chat/completions`. Accept direct JSON or extract exactly one complete JSON object from message content; reject zero, multiple, or unbalanced objects.
7. Treat model output as operations only. Locally assign the plan ID, `source: "ai"`, prompt, current `baseRevision`, and timestamps, then pass the result through the same strict validator as manual plans.
8. Reject model `close_tabs`, settings changes, capability claims, unknown operations/properties, and invalid IDs. Treat explanations as display-only text and render them with DOM `textContent`.
9. Store tokens with the secure mechanism proven in Phase 0 or in memory only. Never include them in settings, exports, errors, or logs.
10. Add a local fake provider test for consent, projection, origin policy, timeout, size limits, bad JSON/schema, redacted logging, and proof that provider output cannot apply itself.
11. Verify one real Ollama request and one configured OpenAI-compatible request in the disposable profile.

### Required check

```sh
node --test tests/core.test.mjs
```

- [x] `none` mode makes zero network requests.
- [x] The first request cannot run before disclosure approval.
- [x] Only the previewed projection is sent.
- [x] Invalid or oversized output reaches no mutation path.
- [x] Returned plans remain editable and require the normal review/apply approval.
- [x] Tokens do not survive restart when secure storage is unavailable.

Verification on 2026-08-29: 18 native tests passed; local Ollama (`qwen3.6:latest`)
returned a validated editable plan; a disposable OpenAI-compatible endpoint completed
the preview/consent/generate/edit flow; and Firefox Login Manager passed save, reload,
and removal through the product adapter. Neither provider test invoked Apply.

### Outcome resolution

- **Provider unavailable/timeout:** retain the current snapshot and draft; show a retry/configuration action.
- **Invalid output:** show `PROVIDER_OUTPUT_INVALID`; never try to repair it into executable operations silently.
- **Secure storage unavailable:** use memory-only tokens and disclose that behavior.
- **LAN HTTP selected:** require the unencrypted-metadata warning; cancellation leaves provider disabled.
- **Provider mode fails:** manual and deterministic workflows remain unaffected and releasable.

## 9. Phase 5 — Release hardening and Sine package

### Goal

Prove the P0 contract on the minimum and current supported Zen versions and package only what passed.

### Implementation steps

1. Complete keyboard navigation, semantic labels, visible focus, non-color status, WCAG 2.1 AA contrast, and reduced-motion handling.
2. Run the 300-tab/10-Space/20-Folder disposable-profile scenarios from spec section 20, including drift, one forced partial failure, provider consent, and `none` mode.
3. Record snapshot/search/apply timings. Optimize only a measured miss.
4. Test the minimum and current Zen versions. Populate a small compatibility table from evidence, not version strings alone.
5. Add the confirmed Sine metadata, MIT `LICENSE`, and a concise `README.md` covering install, compatibility, provider setup, privacy, recovery, and clear-data behavior.
6. Verify Clear organizer data removes organizer settings/draft/results and its stored credential, but does not touch Zen state.
7. Package the mod, generate its checksum, install that package into a fresh disposable profile, and rerun the release smoke test.

### Release gate

- [x] Every implemented P0 acceptance path has direct regression or disposable-profile evidence.
- [x] Performance targets pass; exact 10-Space fixture parity is documented separately.
- [x] No tab is lost in the complete 50-tab apply/restart run.
- [x] No browsing metadata leaves Zen before explicit consent.
- [x] No direct session-file write or inbound listener exists.
- [x] Source package, checksum, README, privacy/recovery guidance, and compatibility table are present.

Phase 5 evidence and the remaining fresh-Sine-install hold are tracked in
`docs/release-checklist.md`.

### Outcome resolution

- **All gates pass:** publish v1.
- **Mutation compatibility fails:** publish only an explicitly labeled read-only preview, or hold release.
- **Provider fails while core passes:** release may ship with provider mode disabled only if the release is relabeled and the unmet P0 item is documented; otherwise hold v1.
- **Accessibility, privacy, tab-loss, or consent gate fails:** hold release.
- **Performance misses:** profile first; add only the smallest fix that resolves the measured bottleneck.

## 10. P0 traceability

| Spec requirement | Implemented in | Release proof |
|---|---|---|
| Live inventory and nested hierarchy | Phases 0–1 | Disposable restored-profile inventory |
| Manual bulk organization | Phases 2–3 | Reviewed 50-tab move and restart |
| Approval, drift, IDs, partial failure | Phases 2–3 | Core/fake tests plus forced failure |
| Duplicates and inactivity | Phase 2 | Pure core tests and UI labels |
| `none`, Ollama, OpenAI-compatible | Phase 4 | Zero-network, fake, and real-provider checks |
| Disclosure and token safety | Phase 4 | Consent/projection/storage tests |
| Missing private APIs fail closed | Phases 0, 1, 3 | Capability test and incompatible-profile smoke test |
| Accessibility and performance | Phase 5 | Keyboard/WCAG review and recorded timings |
| Sine distribution and recovery docs | Phase 5 | Fresh-profile packaged smoke test |

## 11. Deferred until evidence requires them

- All P1 and P2 features.
- Generic `/v1/plan`, MCP, native companion, hosted server, and standard WebExtension adapters.
- Drag-and-drop, saved rules, inverse-plan undo, import/export, custom shortcuts, and telemetry.
- Database, framework, build pipeline, background worker, cache, and incremental Zen event processing.
- Custom URL tracking-parameter removal, embeddings, page-content crawling, or autonomous cleanup.

Add a deferred item only after the MVP is passing and a measured limitation or real user need justifies it.
