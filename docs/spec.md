# Zen Organizer — Implementation Specification

**Status:** Ready for implementation spike  
**Version:** 0.1  
**Date:** 2026-08-28  
**Primary target:** Zen Browser 1.21.15b or newer, distributed as a Sine mod  
**Working name:** Zen Organizer

## 1. Executive decision

Build Zen Organizer first as a Zen/Sine mod, not as a conventional Firefox WebExtension and not as a standalone hosted application.

The mod will:

- Render a full-page organizer UI inside Zen.
- Read the live Zen tab, Space, Folder, pinned-tab, Essential, and Split View state through Zen's privileged browser-window APIs.
- Let users search, filter, bulk-select, and stage organization changes.
- Generate deterministic suggestions locally.
- Optionally request organization plans from an Ollama, LM Studio, OpenAI-compatible, or compatible self-hosted endpoint.
- Validate every proposed operation locally.
- Show a complete diff and require explicit approval before changing Zen.
- Apply approved changes through Zen's live APIs and allow Zen's own session manager to persist them.

The mod must never rewrite `zen-sessions.jsonlz4` or any other live profile file.

No custom organizer server is required for v1. Users who want self-hosting point the mod at an existing compatible model endpoint. A dedicated server and a standard Firefox extension are future adapters, not v1 dependencies.

## 2. Problem statement

Zen users can accumulate hundreds of tabs distributed among Spaces, Folders, pinned tabs, Essentials, and Split Views. Zen exposes these concepts visually, but it does not provide a fast global organizer, bulk triage workflow, or safe AI-assisted planning surface.

The motivating profile contains 361 real tabs across 12 Spaces, including 267 ungrouped tabs and multiple exact duplicates. Manually understanding and reorganizing this volume is slow and error-prone. Directly editing Zen's session files is unsafe because the files contain cross-referenced state and Zen may overwrite or reject external changes.

## 3. Product principles

1. **Local execution owns mutations.** A model or remote server may propose operations but can never apply them.
2. **Plan before apply.** All mutations must exist in a visible, editable plan first.
3. **No silent destructive actions.** Closing tabs requires separate confirmation; AI auto-apply is forbidden.
4. **Minimal disclosure.** Only an explicit safe projection may leave the browser.
5. **Desired-state operations.** Applying an operation twice must not corrupt state or create duplicate work.
6. **Zen remains the source of truth.** The organizer stores settings and draft plans, not a second tab database.
7. **Feature-detect private APIs.** Zen internals are not stable public APIs; incompatibility must fail closed.

## 4. Goals

### User goals

- Let a user understand hundreds of tabs across all Spaces in one view.
- Let a user move or categorize at least 50 selected tabs in one reviewed operation.
- Find exact duplicates without sending data to a model.
- Let a user ask a local or self-hosted model for an organization plan.
- Guarantee that no proposed AI action changes Zen until the user approves it.

### Engineering goals

- Load and display 500 tabs in under two seconds on a current desktop Mac after Zen initialization.
- Apply a 50-tab move plan in under five seconds, excluding page-load time.
- Preserve all tabs if an operation fails partway through.
- Make all Zen-private API calls pass through one adapter module.
- Send no network request before the user configures a provider and grants disclosure consent.

## 5. Non-goals for v1

- **Mozilla Add-ons publication:** Standard WebExtensions do not currently expose reliable Zen Folder/Space mutation APIs.
- **Custom hosted organizer service:** Direct model-provider support covers the first self-hosting use case.
- **Native Messaging companion:** It adds a second installer and does not solve Zen-private mutation by itself.
- **Raw profile-file mutation:** The mod must not write `zen-sessions.jsonlz4`, `places.sqlite`, `prefs.js`, or session backups.
- **Cross-device synchronization:** Zen remains responsible for persistence and sync.
- **Background autonomous cleanup:** The organizer runs only after a user opens it or explicitly invokes an action.
- **Page-content crawling or embeddings:** v1 may use tab titles and sanitized URLs only.
- **Automatic Space deletion or merging:** The mod may propose tab moves but not delete Spaces.
- **Mobile support:** Desktop Zen only.
- **Telemetry:** No analytics or remote logging in v1.

## 6. Personas and user stories

### Primary persona: Zen power user

- As a Zen power user, I want to see every Space, Folder, and tab in one interface so that I can understand my browser state.
- As a user with hundreds of tabs, I want to filter and bulk-select tabs so that I can reorganize them quickly.
- As a privacy-conscious user, I want deterministic duplicate and staleness analysis to run locally so that no provider sees my browsing data.
- As a local-AI user, I want to connect Ollama or LM Studio so that I can request organization suggestions without using a cloud model.
- As a self-hosting user, I want to configure a compatible endpoint URL, model, and token so that I control the planning service.
- As a cautious user, I want to preview and edit every operation before applying it so that the organizer cannot unexpectedly change my browser.
- As a user whose browser state changed after a plan was generated, I want stale operations rejected so that the wrong tabs are not moved.
- As a keyboard user, I want the complete review workflow to be operable without a mouse.

### Secondary persona: external agent user

- As a user of Codex or another agent, I eventually want an MCP adapter over the same read/plan contracts so that an external agent can propose organization plans without receiving direct mutation authority.

This secondary story is P2 and must not influence the v1 implementation beyond keeping plan schemas serializable.

## 7. High-level architecture

```text
┌──────────────────────────── Zen Browser ─────────────────────────────┐
│                                                                     │
│  Zen live state                                                     │
│  gZenWorkspaces / gZenFolders / gBrowser                            │
│          │                                      ▲                   │
│          ▼                                      │ approved only     │
│  ┌────────────────┐    ┌────────────────┐    ┌─────────────────┐   │
│  │ Zen adapter    │───▶│ Organizer core │───▶│ Plan executor   │   │
│  └────────────────┘    └───────┬────────┘    └─────────────────┘   │
│                                │                                    │
│                         ┌──────▼───────┐                            │
│                         │ Full-page UI │                            │
│                         └──────┬───────┘                            │
└────────────────────────────────┼────────────────────────────────────┘
                                 │ sanitized snapshot + prompt
                                 ▼
                    ┌───────────────────────────┐
                    │ Optional model endpoint   │
                    │ Ollama / LM Studio /      │
                    │ OpenAI-compatible / LAN   │
                    └───────────────────────────┘
```

### Component boundaries

#### Zen adapter

The only component allowed to call Zen-private APIs or inspect Zen DOM elements.

Responsibilities:

- Wait for Zen workspaces and session restoration to finish.
- Read all live Spaces, Folders, tabs, Essentials, pinned state, containers, and Split View membership.
- Convert Zen objects into the normalized snapshot schema.
- Resolve normalized IDs back to live Zen objects during preflight and execution.
- Apply desired-state operations using live Zen APIs.
- Return per-operation success or structured failure.
- Expose capability flags based on feature detection.

No UI or model-provider code belongs in this adapter.

#### Organizer core

Pure logic with no direct DOM or Zen access.

Responsibilities:

- Validate and index snapshots.
- Filter and search tabs.
- Detect exact duplicates.
- Compute rough inactivity buckets.
- Create, edit, validate, and order plans.
- Sanitize provider payloads.
- Parse and validate model output.
- Calculate a snapshot revision.

#### Full-page UI

Responsibilities:

- Space/Folder navigation.
- Tab filtering and bulk selection.
- Deterministic suggestions.
- Prompt input and provider configuration.
- Plan review, editing, and approval.
- Apply progress and error reporting.

#### Provider adapter

Responsibilities:

- Support `none`, `ollama`, and `openai-compatible` provider modes.
- Build provider requests from the safe snapshot projection.
- Require disclosure consent before the first request.
- Enforce timeouts and response-size limits.
- Return untrusted JSON to the plan validator; never call the Zen adapter.

## 8. Required implementation spike

Before building the UI, run a throwaway-profile compatibility spike against the minimum supported Zen version.

Verify these operations through the installed Zen APIs:

1. Enumerate all Spaces and all stored tabs, including inactive Spaces.
2. Enumerate nested Zen Folders and their member tabs.
3. Create a Folder in a specified Space.
4. Move a tab between Spaces.
5. Move a tab into and out of a Folder.
6. Rename a Folder.
7. Pin and unpin a tab.
8. Close a normal tab and confirm Firefox/Zen undo-close can recover it.
9. Restart Zen and confirm all successful changes persist.

Expected API entry points include `gZenWorkspaces`, `gZenFolders`, `gBrowser`, `gZenWorkspaces.getWorkspaces()`, `gZenWorkspaces.allStoredTabs`, and `gZenWorkspaces.moveTabToWorkspace(...)`. The implementer must confirm exact callable Folder methods from the installed Zen source instead of guessing them.

The spike is blocking. If create/move Folder operations cannot be performed safely through live APIs, ship a read-only prototype and document the missing capability. Do not fall back to editing session files.

## 9. Normalized data model

Use plain serializable objects. IDs remain opaque strings.

```ts
type Snapshot = {
  schemaVersion: 1;
  revision: string;
  capturedAt: number;
  activeSpaceId: string | null;
  capabilities: Capabilities;
  spaces: Space[];
  folders: Folder[];
  tabs: Tab[];
};

type Capabilities = {
  readAllSpaces: boolean;
  createFolder: boolean;
  moveTabToSpace: boolean;
  moveTabToFolder: boolean;
  renameFolder: boolean;
  setPinned: boolean;
  closeTab: boolean;
};

type Space = {
  id: string;
  name: string;
  icon: string | null;
  position: number;
  containerId: number;
};

type Folder = {
  id: string;
  name: string;
  spaceId: string;
  parentFolderId: string | null;
  position: number;
  collapsed: boolean;
};

type Tab = {
  id: string;
  title: string;
  url: string;
  hostname: string;
  spaceId: string;
  folderId: string | null;
  containerId: number;
  pinned: boolean;
  essential: boolean;
  selected: boolean;
  splitViewId: string | null;
  lastAccessedAt: number | null;
};
```

### Stable tab identity

- Prefer Zen's stable sync/tab ID attribute.
- Never identify a tab by URL or title.
- Tabs without a stable ID may receive an in-memory ephemeral ID, but operations targeting them must be rejected after a snapshot refresh.

### Snapshot revision

Calculate a SHA-256 hash over a canonical, sorted list of:

```text
tab ID | Space ID | Folder ID | pinned | essential
folder ID | Space ID | parent Folder ID | name
```

The revision detects plan drift without hashing page content or URLs.

## 10. Plan and operation schema

```ts
type Plan = {
  schemaVersion: 1;
  id: string;
  source: "manual" | "deterministic" | "ai";
  prompt: string | null;
  baseRevision: string;
  createdAt: number;
  operations: Operation[];
};

type Operation =
  | {
      id: string;
      type: "create_folder";
      folderRef: string;
      name: string;
      spaceId: string;
      parentFolderId: string | null;
    }
  | {
      id: string;
      type: "rename_folder";
      folderId: string;
      name: string;
    }
  | {
      id: string;
      type: "move_tabs";
      tabIds: string[];
      targetSpaceId: string;
      targetFolderId: string | null;
      targetFolderRef?: string;
    }
  | {
      id: string;
      type: "set_pinned";
      tabIds: string[];
      pinned: boolean;
    }
  | {
      id: string;
      type: "close_tabs";
      tabIds: string[];
    };
```

### Validation rules

- Reject unknown operation types and unknown properties.
- Reject unknown, duplicate, placeholder, or ephemeral tab IDs.
- Reject unknown Space and Folder IDs.
- Reject Folder references that are not created earlier in the same plan.
- Reject moves that would exceed Zen's supported Folder nesting depth.
- Exclude Essentials from AI-generated operations unless the user explicitly enables them for that plan.
- Reject `close_tabs` operations from model output by default. The user must manually enable each close operation.
- Cap a plan at 500 operations and 1,000 referenced tabs.
- Trim and validate names using Zen's actual naming limits discovered during the spike.
- Model explanations are display-only strings and must never be interpreted as commands.

### Execution order

1. Refresh live state and recompute the revision.
2. If the revision changed, revalidate every operation against the new snapshot and show the drift. Never silently continue.
3. Create Folders and resolve `folderRef` values.
4. Rename existing Folders.
5. Move tabs to target Spaces.
6. Move tabs into target Folders.
7. Set pinned state.
8. Run separately confirmed closes last.

Return a result for every operation. Stop after an operation fails if later operations depend on it; independent operations may continue only when the UI clearly reports partial completion.

## 11. Safe provider projection

The provider must never receive the raw Zen session, navigation history, form data, storage, cookies, referrers, scroll state, container names, or profile paths.

Default provider payload:

```ts
type ProviderSnapshot = {
  schemaVersion: 1;
  spaces: Array<{ id: string; name: string }>;
  folders: Array<{
    id: string;
    name: string;
    spaceId: string;
    parentFolderId: string | null;
  }>;
  tabs: Array<{
    id: string;
    title: string;
    hostname: string;
    spaceId: string;
    folderId: string | null;
    pinned: boolean;
    essential: boolean;
    lastAccessedDays: number | null;
  }>;
};
```

### Disclosure options

Default enabled:

- Tab title
- Hostname only
- Space and Folder names
- Pinned/Essential state
- Coarse last-accessed bucket

Default disabled:

- Full URL path
- Query string
- URL fragment
- Page snippets or content
- Localhost/private-network hostnames

Before the first request to a provider, show an exact preview and require consent. Consent is scoped to the configured origin and can be revoked.

## 12. Provider contracts

### Provider modes

#### None

No network access. Manual organization and deterministic suggestions remain fully functional.

#### Ollama

- Configurable base URL; default `http://127.0.0.1:11434`.
- Configurable model name.
- Use Ollama's supported structured-output mechanism when available.

#### OpenAI-compatible

- Configurable base URL, model, and optional bearer token.
- Support a `/v1/chat/completions`-compatible request.
- Prefer strict JSON schema or tool/function output when supported.
- Fall back to extracting one JSON object from the response and validating it locally.

### Network policy

- Make no request before explicit provider setup and disclosure consent.
- Allow plain HTTP without an interstitial only for `localhost` and `127.0.0.1`.
- Permit private-LAN HTTP only after a warning that tab metadata will travel unencrypted.
- Require HTTPS for public hostnames.
- Default timeout: 60 seconds.
- Maximum response body: 1 MB.
- Never follow redirects from a private/local origin to a public origin without renewed consent.
- Log only provider origin, duration, status, and error category; never log prompts, titles, URLs, or tokens.

### Secret storage

- Never store bearer tokens in `prefs.js`, mod preferences, logs, or exported settings.
- Prefer Firefox Login Manager through privileged APIs.
- If secure storage is not available, keep the token in memory for the current session and explain that limitation.

## 13. Deterministic suggestions

These run locally and require no model:

### Exact duplicates

- Compare normalized current URLs.
- Remove fragments.
- Preserve query strings for equality; do not remove tracking parameters in v1.
- Group exact matches and propose keeping one.
- Prefer keeping, in order: Essential, pinned, selected, most recently accessed.
- Never automatically close duplicates.

### Inactivity buckets

- Group ungrouped tabs into `30+`, `90+`, and `180+` days since `lastAccessedAt`.
- Label this as last selection time, not creation time or proof of irrelevance.

### Space and Folder summaries

- Show tab count, ungrouped count, pinned count, and inactive count for each Space and Folder.
- Flag Spaces whose names overlap existing Folder names as a review hint only.

## 14. UI specification

Use a full-page manager tab. Do not use a toolbar popup or small widget for the primary workflow.

```text
┌──────── Spaces/Folders ────────┬──────── Tabs ─────────┬──── Plan ────┐
│ All tabs                 361   │ [Search___________]   │ 12 changes   │
│ Duplicates                18   │ [ ] Title / host      │ + Folder     │
│ Old ungrouped             83   │ [ ] Title / host      │ → 8 tabs     │
│                               │ [ ] Title / host      │              │
│ Space A                  202   │                       │ [Review]     │
│   Folder 1                 9   │                       │ [Apply]      │
│ Space B                   46   │                       │              │
└────────────────────────────────┴───────────────────────┴──────────────┘
```

### Required views

- All tabs
- Ungrouped tabs
- Exact duplicates
- Inactivity buckets
- Individual Space
- Individual Folder
- Draft plan
- Provider settings and disclosure preview

### Tab list requirements

- Search title, hostname, Space, and Folder.
- Filter pinned, Essential, grouped, ungrouped, and inactivity bucket.
- Sort by title, hostname, last accessed, Space, and Folder.
- Support select-all for the filtered result.
- Show selected count and target Space/Folder bulk actions.
- Virtualize or otherwise keep 500 rows responsive.

### Plan review requirements

- Group operations by type and destination.
- Show before and after location for moved tabs.
- Allow removing individual tabs or entire operations.
- Highlight closes in a destructive color and require separate confirmation.
- Display snapshot drift before apply.
- Show per-operation progress and result.
- Keep the successful portion visible when a plan partially fails.

### Accessibility

- Meet WCAG 2.1 AA contrast.
- Use semantic labels and visible focus indicators.
- Support keyboard navigation, selection, plan editing, and apply confirmation.
- Respect reduced-motion preferences.
- Do not encode status only with color.

## 15. Functional requirements and acceptance criteria

### P0 — required to ship v1

#### Live inventory

- [ ] Given Zen has restored its session, when the organizer opens, then all live Spaces, Folders, and tabs appear.
- [ ] Given a nested Folder exists, when the organizer opens, then the correct parent-child hierarchy is shown.
- [ ] Internal placeholder, empty, and Glance-only structural tabs are excluded from normal results.
- [ ] The active Space and selected tabs are identified.

#### Manual organization

- [ ] A user can select filtered tabs and stage a move to an existing Space or Folder.
- [ ] A user can stage Folder creation and move tabs into the new Folder in one plan.
- [ ] A user can remove or edit operations before applying.
- [ ] Applying a plan uses live Zen APIs and persists after restart.
- [ ] The organizer never writes profile session files directly.

#### Safety

- [ ] No mutation occurs before explicit approval.
- [ ] A changed snapshot triggers drift review before apply.
- [ ] Unknown or missing tab IDs are rejected.
- [ ] Essentials are excluded from generated plans by default.
- [ ] Close operations require separate confirmation.
- [ ] A partial failure reports exactly what succeeded and failed.

#### Deterministic analysis

- [ ] Exact duplicate detection runs locally.
- [ ] Duplicate suggestions never close tabs automatically.
- [ ] Inactivity buckets explain that they represent last selection.

#### Provider support

- [ ] The organizer works fully in `none` mode without network access.
- [ ] Ollama and OpenAI-compatible endpoints can be configured.
- [ ] The first request shows the exact disclosure projection and requires consent.
- [ ] Provider output is rejected unless it passes the operation schema and local capability checks.
- [ ] Tokens are never stored in plaintext preferences or logs.

#### Compatibility

- [ ] Missing Zen-private APIs disable mutation controls and show a useful compatibility message.
- [ ] A Zen version change cannot cause a fallback to raw file editing.

### P1 — fast follow

- Drag-and-drop plan editing.
- Saved local organization rules by hostname.
- Undo the last applied non-close plan by recording its inverse desired state.
- Import/export plans with URLs and titles removed by default.
- Preview how much metadata each provider request contains.
- Custom compatible planner endpoint using a documented `/v1/plan` contract.
- User-defined ignore lists for domains and tabs.
- Command palette and configurable keyboard shortcuts.

### P2 — future

- Standard Firefox WebExtension adapter if Zen publishes stable Space/Folder APIs.
- Native Messaging companion for browsers without privileged integration.
- Dockerized planner service.
- MCP adapter exposing read and propose tools; apply remains approval-gated.
- Optional page-content indexing and local embeddings.
- Multi-profile and cross-device organization.
- Signed community rule packs.

## 16. State and storage

Zen remains the source of truth. Store only:

- UI preferences
- Provider origin and model name
- Disclosure consent keyed by provider origin
- Non-secret deterministic rules when P1 is implemented
- Current draft plan
- Last apply result for recovery and support

Do not build a database in v1. Use one versioned JSON object in the mod's supported local storage mechanism. Keep tokens in secure storage or memory, separately from exported settings.

Draft plans must be invalidated or revalidated after Zen restarts.

## 17. Error handling

Use structured error codes:

```text
ZEN_API_UNAVAILABLE
SNAPSHOT_NOT_READY
SNAPSHOT_DRIFT
TAB_NOT_FOUND
FOLDER_NOT_FOUND
CAPABILITY_UNAVAILABLE
INVALID_PLAN
PROVIDER_UNREACHABLE
PROVIDER_TIMEOUT
PROVIDER_RESPONSE_TOO_LARGE
PROVIDER_OUTPUT_INVALID
OPERATION_FAILED
SECURE_STORAGE_UNAVAILABLE
```

UI errors must state:

- What failed
- Whether anything changed
- Which operations succeeded
- A safe next action

Never show tokens or raw provider responses containing tab metadata in normal logs.

## 18. Security and privacy requirements

- Treat tab titles and hostnames as sensitive personal data.
- Keep all apply capabilities local to the mod.
- Do not expose an inbound HTTP listener in v1.
- Validate provider origins and redirect destinations.
- Parse provider output as data only; never evaluate returned JavaScript, HTML, CSS, URLs, or instructions.
- Escape all titles, Folder names, and provider explanations before rendering.
- Require an explicit user gesture before the first provider request and before apply.
- Use a strict allowlist of operation types.
- Do not let model output modify provider settings, consent, tokens, or capability flags.
- Redact titles, hosts, prompts, and tokens from logs and crash reports.
- Provide a one-click "Clear organizer data" action that does not touch Zen state.

## 19. Performance targets

- Initial snapshot and index: under 2 seconds for 500 tabs and 100 Folders.
- Search/filter response: under 100 ms after indexing.
- UI remains responsive while provider requests run.
- Apply 50 independent tab moves: under 5 seconds on the reference machine.
- Provider request payload: under 512 KB by default; reject larger payloads or require explicit narrowing.
- Provider response: maximum 1 MB.

No caching layer or background worker is required in v1. Recompute the in-memory index when the organizer opens or after an apply. Add incremental event handling only if profiling shows the refresh is disruptive.

## 20. Testing strategy

### Unit tests

- Snapshot normalization
- Revision hashing
- URL sanitization
- Exact duplicate detection
- Provider projection
- Strict plan validation
- Operation ordering
- Drift revalidation
- Redacted logging

### Adapter tests with a fake Zen environment

- All-Spaces enumeration
- Nested Folders
- Missing stable IDs
- Missing capabilities
- Partial execution failure
- Idempotent desired-state moves
- Exclusion of placeholder and Essential tabs

### End-to-end tests

Use a disposable Zen profile. Never run destructive tests against a developer's real profile.

Required scenarios:

1. Load 300 generated tabs across 10 Spaces and 20 Folders.
2. Create a Folder and move 50 tabs into it.
3. Restart Zen and verify persistence.
4. Generate a model plan using a local fake provider.
5. Confirm no operation runs before approval.
6. Change a tab after plan generation and verify drift handling.
7. Simulate one failed operation and verify accurate partial results.
8. Confirm no network request occurs in `none` mode or before consent.

## 21. Distribution

### V1

- Package for Sine's mod format.
- Publish source under an OSI-approved license; MIT is recommended.
- Include versioned releases and checksums.
- Document supported Zen versions.
- Include installation, provider configuration, privacy model, and recovery instructions.
- State clearly that the project uses Zen-private APIs and may require updates after Zen releases.

### Compatibility policy

- Feature-detect at runtime in addition to checking the Zen version.
- Maintain a small compatibility table in the README.
- Disable mutation on unknown/incompatible versions until verified.
- Never claim compatibility based only on a version string.

## 22. Suggested minimal repository layout

```text
zen-organizer/
├── organizer.uc.mjs          # Sine entry point and lifecycle
├── zen-adapter.mjs           # all Zen-private access
├── organizer-core.mjs        # snapshot, search, suggestions, plans
├── providers.mjs             # provider requests and safe projection
├── organizer.html            # full-page UI
├── organizer.css
├── preferences.json          # Sine settings metadata if required
├── theme.json                # Sine package metadata if required
├── tests/
│   ├── core.test.mjs
│   └── fake-zen-adapter.mjs
├── README.md
└── LICENSE
```

Do not add a framework, database, server, build pipeline, or package abstraction unless the first implementation proves it necessary. Plain modules and browser-native UI are sufficient for v1.

## 23. Implementation sequence

1. Complete the blocking Zen API spike in a disposable profile.
2. Implement the normalized snapshot and fake adapter.
3. Implement read-only UI with search, filters, summaries, and exact duplicates.
4. Implement manual plan creation and strict validation.
5. Implement live preflight and approved apply.
6. Add provider projection and a local fake provider.
7. Add Ollama.
8. Add OpenAI-compatible provider support and secure token storage.
9. Add accessibility and performance checks.
10. Run end-to-end tests on the minimum and current Zen versions.
11. Package for Sine and write public documentation.

## 24. Success criteria

V1 is successful when:

- A user with 300+ tabs can understand the distribution of tabs across Spaces and Folders from one screen.
- The user can reorganize at least 50 tabs through one reviewed plan.
- A local fake provider and a real Ollama endpoint can each generate a valid, editable plan.
- No model or server can directly mutate Zen.
- No tab is lost in the complete end-to-end suite.
- No browsing metadata leaves Zen before explicit consent.
- The organizer works without any configured AI provider.

Because v1 has no telemetry, measure these criteria through automated tests, release-checklist timings, and opt-in issue templates rather than analytics.

## 25. Open questions

### Blocking

1. **Exact Folder mutation APIs:** Which current Zen methods safely create, nest, and move tabs into Folders? Resolve during the spike from installed source.
2. **Full-page registration:** What is the least brittle Sine-compatible way to register and open the organizer page in the current Zen build?
3. **Secure token storage:** Can the mod reliably use Firefox Login Manager across supported Zen versions? If not, v1 tokens remain memory-only.

### Non-blocking

1. Should the first public release support a generic `/v1/plan` server, or wait until after direct provider feedback?
2. Should close operations ship in v1 or remain disabled until undo-plan support exists?
3. Should local hostname disclosure be fully blocked rather than user-configurable?
4. What final name and icon should be used for publication?

## 26. Revisit as the project grows

Reconsider the architecture only when evidence requires it:

- Add a custom server when users need persistent indexing, shared prompts, or multi-device access.
- Add a database when retained history or multiple profiles make a versioned JSON object insufficient.
- Add an MCP adapter when external-agent usage is demonstrated.
- Add a conventional extension when Zen exposes stable public APIs.
- Add a native companion only when a supported capability cannot live safely in the mod.
- Add incremental event processing only when full snapshot refresh is measurably too slow.

## 27. Reference material

- Zen session manager: <https://github.com/zen-browser/desktop/blob/dev/src/zen/sessionstore/ZenSessionManager.sys.mjs>
- Zen Space manager: <https://github.com/zen-browser/desktop/blob/dev/src/zen/spaces/ZenSpaceManager.mjs>
- Zen Folder implementation: <https://github.com/zen-browser/desktop/blob/dev/src/zen/folders/ZenFolders.mjs>
- Zen tab-state additions: <https://github.com/zen-browser/desktop/blob/dev/src/browser/components/sessionstore/TabState-sys-mjs.patch>
- Zen Folder API discussion: <https://github.com/zen-browser/desktop/discussions/11824>
- Zen Tab Sorting precedent: <https://github.com/LoopRook/Zen-Tab-Sorting>
- Mozilla Native Messaging, for a future conventional extension: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>
- Zen Window Sync and recovery guidance: <https://docs.zen-browser.app/user-manual/window-sync>

## 28. Definition of done

- [ ] Blocking compatibility spike completed and documented.
- [ ] Read-only inventory covers every supported Zen concept.
- [ ] Manual bulk plans can be reviewed and safely applied.
- [ ] Exact duplicate and inactivity suggestions work locally.
- [ ] Ollama and OpenAI-compatible provider modes pass validation tests.
- [ ] Disclosure preview and consent are enforced.
- [ ] Drift and partial failure behavior are tested.
- [ ] Accessibility and performance targets are met.
- [ ] Disposable-profile end-to-end suite passes.
- [ ] No direct session-file writes exist in the codebase.
- [ ] Sine package, README, privacy documentation, and license are ready.
