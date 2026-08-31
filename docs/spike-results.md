# Zen Organizer — Compatibility Spike Results

**Status:** Pass for implementation; packaged Sine smoke test remains a release gate  
**Date:** 2026-08-28  
**Profile:** Disposable headless profile only

## Target

| Item | Observed value |
|---|---|
| Zen | 1.21.15b |
| Gecko | 154.0 |
| Build ID | 20260818101929 |
| Zen source stamp | `cee4147767801299dec330c81318c01e5a39e6ec` |
| macOS | 26.4.1 (25E253) |
| Sine | Not installed; source inspected at `b455623296b784c765786d680e69e4b7645f66e9` |

The installed Zen source was read from `/Applications/Zen.app/Contents/Resources/browser/omni.ja`. Runtime checks used geckodriver 0.37.1 with system access against `/tmp/zen-zest-persist-profile-20260828`. The user's running profile was not automated or changed.

## Gate result

- [x] Enumerate all Spaces and stored tabs.
- [x] Enumerate nested Folders and membership.
- [x] Create a Folder in a chosen Space.
- [x] Move a tab between Spaces.
- [x] Move a tab into and out of a Folder.
- [x] Rename a Folder.
- [x] Pin and unpin a tab.
- [x] Close a tab and recover it with undo-close.
- [x] Restart and verify successful changes persisted.
- [x] Verify a full-page privileged chrome document can be registered and opened.
- [x] Verify Firefox Login Manager add/search/remove in the mod's privileged context.
- [x] Confirm no profile/session file mutation is needed.

## Verified API map

### Readiness

Wait for both promises before taking the first snapshot:

```js
await Promise.all([
  gZenWorkspaces.promiseInitialized,
  SessionStore.promiseAllWindowsRestored,
]);
```

`gZenWorkspaces.promiseInitialized` resolves after workspace containers, restored tabs, and tab positions are initialized. `SessionStore.promiseAllWindowsRestored` prevents an early partial inventory.

### Inventory

| Data | Verified source |
|---|---|
| Spaces | `gZenWorkspaces.getWorkspaces()` |
| Active Space | `gZenWorkspaces.activeWorkspace` |
| All Space tabs | `gZenWorkspaces.allStoredTabs` |
| Folders and Split Views | `gBrowser.tabGroups` |
| Stable tab ID | `tab.id` / the stored `zenSyncId` |
| Space membership | `tab.getAttribute("zen-workspace-id")` |
| Direct Folder | `tab.group?.isZenFolder ? tab.group : null` |
| Split View | `tab.group?.hasAttribute("split-view-group") ? tab.group.id : null` |
| Folder containing a Split View | `tab.group?.group?.isZenFolder ? tab.group.group : null` |
| Container | `tab.userContextId` |
| Essential | `tab.getAttribute("zen-essential") === "true"` |
| Selected | `tab.selected` |
| Last accessed | `tab.lastAccessed` |

`tab.id` survived restart unchanged. A tab without a non-empty `id` must therefore be treated as ephemeral and rejected from refreshed plans.

Exclude `zen-empty-tab`, `zen-glance-tab`, and `FirefoxViewHandler.tab` from normal inventory. Do not exclude a user tab merely because its URL is `about:blank`.

### Folder hierarchy

Use `group.id`, `group.label`, `group.collapsed`, `group.getAttribute("zen-workspace-id")`, and `group.group?.id`. `gZenFolders.storeDataForSessionStore()` confirmed the same `parentId` hierarchy used during persistence.

The `zen.folders.max-subfolders` preference is `5` on this build. Valid levels are 0 through 4. The rename UI trims/collapses whitespace but enforces no maximum length; the organizer should use its own small input bound.

### Mutations

| Operation | Verified call/behavior |
|---|---|
| Create Folder | `gZenFolders.createFolder(tabs, { workspaceId, label, collapsed })` |
| Create nested Folder | Pass `insertAfter: parent.groupContainer.lastElementChild` |
| Move to Space | `gZenWorkspaces.moveTabToWorkspace(tab, workspaceId)` |
| Move into Folder | `folder.addTabs([tab])` |
| Move out of Folder | `gBrowser.ungroupTab(tab)` |
| Rename Folder | Set `folder.label`, then dispatch bubbling `ZenFolderRenamed` |
| Pin/unpin | `gBrowser.pinTab(tab)` / `gBrowser.unpinTab(tab)` |
| Close | `gBrowser.removeTab(tab, { animate: false })` |
| Recover close | `SessionStore.undoCloseTab(window, 0)` |
| Flush before test shutdown | `gBrowser.TabStateFlusher.flush(tab.linkedBrowser)` |

Do not use `gZenFolders.ungroupTabsFromActiveGroups()` for an ordinary move out of a Folder. The runtime spike showed that it leaves a tab in a non-active Folder; `gBrowser.ungroupTab()` removed it correctly.

`createFolder(tabs, ...)` pins its member tabs. Folder moves must therefore be treated as desired-state location changes and must not promise to preserve an unpinned state that Zen itself does not support inside Folders.

## Persistence evidence

The disposable profile was gracefully closed and reopened. The following all remained true after `SessionStore.promiseAllWindowsRestored` and `gZenWorkspaces.promiseInitialized` resolved:

- the second Space retained its UUID and name;
- the renamed parent Folder retained its ID and label;
- the child Folder retained its ID and parent ID;
- the moved tab retained its stable ID, Space, and parent Folder;
- the pinned tab remained pinned;
- the undo-closed tab was present.

## Full-page registration

Sine's current manager registers a mod's `chromeManifest` with `nsIComponentRegistrar.autoRegister()` before loading its scripts. Its `theme.json` script entries can target `chrome://browser/content/browser.xhtml` with a `.uc.mjs` or `.uc.js` entry.

The spike registered this minimal manifest at runtime:

```text
content zenorganizer .
```

`chrome://zenorganizer/content/organizer.html` then loaded as a full browser tab. The page had `ChromeUtils`, `Cc`, and `Ci` access and resolved the browser window with:

```js
const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(
  Ci.nsIWindowMediator,
);
const browserWindow = windowMediator.getMostRecentWindow("navigator:browser");
```

`browserWindow.gZenWorkspaces` was available and returned both restored Spaces. Use this chrome page for the manager and a small browser-window userscript only to expose an Open Organizer command/button.

The final package still needs one smoke test with Sine installed because Sine is absent from this machine. No product design depends on undocumented Sine globals.

## Secure token storage

`Services.logins.addLoginAsync`, `searchLoginsAsync`, and `removeLoginAsync` all succeeded with a disposable credential, including password round-trip. Remove the spike credential immediately after the check; no credential remains in the test profile.

Use a fixed organizer origin/realm and the normalized provider origin as the username. Keep the memory-only fallback for builds where these methods are absent or fail.

## Compatibility outcome

Proceed with the read/write adapter for Zen 1.21.15b. Every private call must remain feature-detected, and mutation controls must fail closed if any mapped method or DOM shape is missing.

The implemented read-only page was also exercised with 500 real tabs and 100 Folders after Zen initialization. Snapshot/index plus the full 500-row render took 18 ms (35 ms observed wall time), and a search/filter render took 4.85 ms on the reference machine. Plain DOM rendering meets the target, so virtualization is not needed.

The remaining Phase 0 packaging caveat is Sine end-to-end installation, not a Zen mutation blocker. Re-run the package smoke test before claiming release compatibility.
