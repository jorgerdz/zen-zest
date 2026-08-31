import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  applyReviewedPlan,
  appendOperation,
  computeRevision,
  createPlan,
  filterTabs,
  findExactDuplicates,
  inactivityBucket,
  newId,
  orderOperations,
  removeTabFromOperation,
  summarizeSnapshot,
  validatePlan,
  validateSnapshot,
} from "../organizer-core.mjs";
import {
  clearOrganizerData,
  createLiveExecutor,
  isVerifiedZenBuild,
  readSnapshot,
  saveProviderToken,
} from "../zen-adapter.mjs";
import {
  createProviderProjection,
  extractOneJsonObject,
  normalizeProviderConfig,
  prepareProviderRequest,
  requestProviderPlan,
} from "../providers.mjs";

const DAY = 86_400_000;
const NOW = 2_000_000_000_000;

function snapshot() {
  return {
    schemaVersion: 1,
    revision: "",
    capturedAt: NOW,
    activeSpaceId: "space-a",
    capabilities: {
      readAllSpaces: true,
      createFolder: true,
      moveTabToSpace: true,
      moveTabToFolder: true,
      renameFolder: true,
      setPinned: true,
      closeTab: true,
    },
    spaces: [
      { id: "space-a", name: "Work", icon: null, position: 0, containerId: 0 },
      { id: "space-b", name: "Read", icon: null, position: 1, containerId: 0 },
    ],
    folders: [
      {
        id: "folder-a",
        name: "Research",
        spaceId: "space-a",
        parentFolderId: null,
        position: 0,
        collapsed: false,
      },
    ],
    tabs: [
      {
        id: "tab-a",
        title: "Alpha",
        url: "https://example.com/path#one",
        hostname: "example.com",
        spaceId: "space-a",
        folderId: "folder-a",
        containerId: 0,
        pinned: false,
        essential: false,
        selected: false,
        splitViewId: null,
        lastAccessedAt: NOW - 35 * DAY,
      },
      {
        id: "tab-b",
        title: "Beta",
        url: "https://example.com/path#two",
        hostname: "example.com",
        spaceId: "space-a",
        folderId: null,
        containerId: 0,
        pinned: true,
        essential: false,
        selected: false,
        splitViewId: null,
        lastAccessedAt: NOW - 100 * DAY,
      },
      {
        id: "tab-c",
        title: "Gamma",
        url: "https://other.test/?q=1",
        hostname: "other.test",
        spaceId: "space-b",
        folderId: null,
        containerId: 0,
        pinned: false,
        essential: true,
        selected: true,
        splitViewId: null,
        lastAccessedAt: NOW - 200 * DAY,
      },
    ],
  };
}

test("snapshot validation rejects broken references", () => {
  const valid = snapshot();
  assert.equal(validateSnapshot(valid).ok, true);
  valid.tabs[0].folderId = "missing";
  assert.deepEqual(validateSnapshot(valid).errors, ["Unknown Folder for tab tab-a"]);
});

test("revision ignores enumeration order and changes with location", async () => {
  const original = snapshot();
  const reordered = snapshot();
  reordered.tabs.reverse();
  reordered.folders.reverse();
  assert.equal(
    await computeRevision(original, webcrypto.subtle),
    await computeRevision(reordered, webcrypto.subtle),
  );
  reordered.tabs[0].spaceId = "space-a";
  assert.notEqual(
    await computeRevision(original, webcrypto.subtle),
    await computeRevision(reordered, webcrypto.subtle),
  );
});

test("search, filters, and sorts use normalized locations", () => {
  const data = snapshot();
  assert.deepEqual(
    filterTabs(data, { query: "research", now: NOW }).map(tab => tab.id),
    ["tab-a"],
  );
  assert.deepEqual(
    filterTabs(data, { state: "ungrouped", sort: "lastAccessed", direction: "desc", now: NOW }).map(
      tab => tab.id,
    ),
    ["tab-b", "tab-c"],
  );
});

test("duplicates remove fragments and keep the safest tab", () => {
  const groups = findExactDuplicates(snapshot());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keepTabId, "tab-b");
  assert.deepEqual(groups[0].duplicateTabIds, ["tab-a"]);
});

test("inactivity and summaries use last-selection time", () => {
  const data = snapshot();
  assert.equal(inactivityBucket(data.tabs[0].lastAccessedAt, NOW), "30+");
  assert.equal(inactivityBucket(data.tabs[1].lastAccessedAt, NOW), "90+");
  assert.equal(inactivityBucket(data.tabs[2].lastAccessedAt, NOW), "180+");
  assert.deepEqual(
    summarizeSnapshot(data, NOW).spaces.map(space => [space.id, space.total, space.ungrouped]),
    [
      ["space-a", 2, 1],
      ["space-b", 1, 1],
    ],
  );
});

test("strict plans support create-and-move while rejecting unsafe model output", () => {
  const data = snapshot();
  data.revision = "revision-a";
  let plan = createPlan(data, { id: "plan-a", createdAt: NOW });
  plan = appendOperation(plan, {
    id: "create-a",
    type: "create_folder",
    folderRef: "new-folder",
    name: "  New   Folder  ",
    spaceId: "space-a",
    parentFolderId: null,
  });
  plan = appendOperation(plan, {
    id: "move-a",
    type: "move_tabs",
    tabIds: ["tab-a", "tab-b"],
    targetSpaceId: "space-a",
    targetFolderId: null,
    targetFolderRef: "new-folder",
  });
  const valid = validatePlan(plan, data);
  assert.equal(valid.ok, true);
  assert.equal(valid.plan.operations[0].name, "New Folder");

  plan.source = "ai";
  plan.operations.push({ id: "close-a", type: "close_tabs", tabIds: ["tab-c"] });
  const unsafe = validatePlan(plan, data);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.errors.some(error => error.message.includes("Essential tab")), true);
  assert.equal(unsafe.errors.some(error => error.message.includes("cannot close")), true);
});

test("plan validation rejects drift, unknown fields, duplicates, and ephemeral IDs", () => {
  const data = snapshot();
  data.revision = "current";
  data.tabs.push({ ...data.tabs[0], id: "ephemeral:1:1" });
  const plan = {
    ...createPlan(data, { id: "plan-b", createdAt: NOW }),
    baseRevision: "old",
    operations: [
      {
        id: "move-b",
        type: "move_tabs",
        tabIds: ["tab-a", "tab-a", "ephemeral:1:1"],
        targetSpaceId: "space-b",
        targetFolderId: null,
        surprise: true,
      },
    ],
  };
  const result = validatePlan(plan, data);
  assert.equal(result.ok, false);
  assert.deepEqual(
    new Set(result.errors.map(error => error.code)),
    new Set(["SNAPSHOT_DRIFT", "INVALID_PLAN", "TAB_NOT_FOUND"]),
  );
});

test("plan editing removes empty operations and ordering keeps closes last", () => {
  const data = snapshot();
  data.revision = "revision-c";
  let plan = createPlan(data, { id: "plan-c", createdAt: NOW });
  plan = appendOperation(plan, { id: "close", type: "close_tabs", tabIds: ["tab-a"] });
  plan = appendOperation(plan, {
    id: "pin",
    type: "set_pinned",
    tabIds: ["tab-b"],
    pinned: true,
  });
  plan = appendOperation(plan, {
    id: "move",
    type: "move_tabs",
    tabIds: ["tab-a", "tab-b"],
    targetSpaceId: "space-b",
    targetFolderId: null,
  });
  plan = removeTabFromOperation(plan, "move", "tab-a");
  plan = removeTabFromOperation(plan, "move", "tab-b");
  assert.deepEqual(plan.operations.map(operation => operation.id), ["close", "pin"]);
  assert.deepEqual(orderOperations(plan).operations.map(operation => operation.id), ["pin", "close"]);
  assert.match(newId("operation"), /^operation:/);
});

test("apply requires approval and stops on revision drift before mutation", async () => {
  const data = snapshot();
  data.revision = "current";
  const plan = appendOperation(createPlan({ ...data, revision: "old" }), {
    id: "pin-a",
    type: "set_pinned",
    tabIds: ["tab-a"],
    pinned: true,
  });
  const calls = [];
  const driver = {
    readSnapshot: async () => {
      calls.push("read");
      return data;
    },
    setPinned: async () => calls.push("pin"),
  };

  assert.equal((await applyReviewedPlan(plan, driver)).code, "APPROVAL_REQUIRED");
  assert.deepEqual(calls, []);
  const drifted = await applyReviewedPlan(plan, driver, { approved: true });
  assert.equal(drifted.status, "drifted");
  assert.deepEqual(calls, ["read"]);
});

test("apply resolves new Folders, closes last, and reports exact partial results", async () => {
  const data = snapshot();
  data.revision = "revision-d";
  let plan = createPlan(data, { id: "plan-d", createdAt: NOW });
  plan = appendOperation(plan, {
    id: "close-d",
    type: "close_tabs",
    tabIds: ["tab-c"],
  });
  plan = appendOperation(plan, {
    id: "create-d",
    type: "create_folder",
    folderRef: "folder-ref-d",
    name: "Review",
    spaceId: "space-a",
    parentFolderId: null,
  });
  plan = appendOperation(plan, {
    id: "move-d",
    type: "move_tabs",
    tabIds: ["tab-a", "tab-b"],
    targetSpaceId: "space-a",
    targetFolderId: null,
    targetFolderRef: "folder-ref-d",
  });
  plan = appendOperation(plan, {
    id: "pin-d",
    type: "set_pinned",
    tabIds: ["tab-a"],
    pinned: true,
  });
  const calls = [];
  const driver = {
    readSnapshot: async () => data,
    createFolder: async () => {
      calls.push("create");
      return { changed: true, folderId: "folder-new" };
    },
    moveTab: async (tabId, destination) => {
      calls.push(`move:${tabId}:${destination.folderId}`);
      if (tabId === "tab-b") throw Object.assign(new Error("forced"), { code: "OPERATION_FAILED" });
      return { changed: true };
    },
    setPinned: async tabId => calls.push(`pin:${tabId}`),
    closeTab: async tabId => calls.push(`close:${tabId}`),
  };

  const result = await applyReviewedPlan(plan, driver, {
    approved: true,
    closesApproved: true,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["create", "move:tab-a:folder-new", "move:tab-b:folder-new"]);
  assert.deepEqual(result.actions.map(action => action.status), [
    "completed",
    "completed",
    "failed",
    "not_run",
    "not_run",
  ]);
  assert.equal(result.actions.at(-1).type, "close_tabs");
});

test("desired-state no-ops are safe to reapply", async () => {
  const data = snapshot();
  data.revision = "revision-e";
  const plan = appendOperation(createPlan(data, { id: "plan-e", createdAt: NOW }), {
    id: "pin-e",
    type: "set_pinned",
    tabIds: ["tab-b"],
    pinned: true,
  });
  const driver = {
    readSnapshot: async () => data,
    setPinned: async () => ({ changed: false }),
  };
  const options = { approved: true };
  assert.equal((await applyReviewedPlan(plan, driver, options)).actions[0].changed, false);
  assert.equal((await applyReviewedPlan(plan, driver, options)).actions[0].changed, false);
});

test("live adapter desired-state methods avoid duplicate mutations", async () => {
  const calls = [];
  const folder = {
    id: "folder-a",
    isZenFolder: true,
    getAttribute: name => (name === "zen-workspace-id" ? "space-a" : ""),
  };
  const tab = {
    id: "tab-a",
    group: folder,
    pinned: true,
    getAttribute: name =>
      name === "zen-workspace-id" ? "space-a" : name === "zen-essential" ? "false" : "",
  };
  const browserWindow = {
    gZenWorkspaces: {
      allStoredTabs: [tab],
      getWorkspaces: () => [{ uuid: "space-a" }],
      moveTabToWorkspace: async () => calls.push("move-space"),
    },
    gBrowser: {
      tabGroups: [folder],
      ungroupTab: async () => calls.push("ungroup"),
      pinTab: async () => calls.push("pin"),
      unpinTab: async () => calls.push("unpin"),
      removeTab: async () => calls.push("close"),
    },
  };
  const driver = createLiveExecutor(browserWindow);

  assert.deepEqual(await driver.moveTab("tab-a", { spaceId: "space-a", folderId: "folder-a" }), {
    changed: false,
  });
  assert.deepEqual(await driver.setPinned("tab-a", true), { changed: false });
  assert.deepEqual(calls, []);
  browserWindow.gZenWorkspaces.allStoredTabs.push({ ...tab });
  await assert.rejects(driver.setPinned("tab-a", false), { code: "TAB_NOT_FOUND" });
});

test("live snapshot assigns stale global essentials to the active Space", async () => {
  const tab = {
    id: "essential-a",
    group: null,
    label: "Essential",
    linkedBrowser: { currentURI: { spec: "https://example.com/" } },
    pinned: true,
    selected: false,
    userContextId: 0,
    lastAccessed: NOW,
    hasAttribute: name => name === "zen-essential",
    getAttribute: name =>
      name === "zen-workspace-id"
        ? "deleted-space"
        : name === "zen-essential"
          ? "true"
          : "",
  };
  const browserWindow = {
    gBrowser: { tabGroups: [] },
    gZenFolders: {},
    gZenWorkspaces: {
      activeWorkspace: "space-a",
      allStoredTabs: [tab],
      getWorkspaces: () => [{ uuid: "space-a", name: "Work", containerTabId: 0 }],
      promiseInitialized: Promise.resolve(),
    },
    SessionStore: { promiseAllWindowsRestored: Promise.resolve() },
    Services: { appinfo: { version: "test", appBuildID: "test" } },
    customElements: { get: () => undefined },
  };

  assert.equal((await readSnapshot(browserWindow)).tabs[0].spaceId, "space-a");
});

test("provider projection omits URLs and local hostnames", () => {
  const data = snapshot();
  data.tabs[0].hostname = "localhost";
  const projection = createProviderProjection(data);
  assert.equal(projection.tabs[0].hostname, "");
  assert.equal("url" in projection.tabs[0], false);
  assert.equal(projection.tabs[0].lastAccessedDays, 30);
});

test("provider origin policy rejects credentials and public HTTP", () => {
  assert.equal(
    normalizeProviderConfig({
      mode: "ollama",
      origin: "http://127.0.0.1:11434",
      model: "local",
    }).lanHttp,
    false,
  );
  assert.equal(
    normalizeProviderConfig({
      mode: "openai-compatible",
      origin: "http://192.168.1.8:1234",
      model: "lan",
    }).lanHttp,
    true,
  );
  assert.throws(
    () =>
      normalizeProviderConfig({
        mode: "openai-compatible",
        origin: "http://example.com",
        model: "bad",
      }),
    { code: "PROVIDER_UNREACHABLE" },
  );
  assert.throws(
    () =>
      normalizeProviderConfig({
        mode: "openai-compatible",
        origin: "https://token@example.com",
        model: "bad",
      }),
    { code: "PROVIDER_UNREACHABLE" },
  );
});

test("none mode makes no request and providers require preview approval", async () => {
  let calls = 0;
  const none = prepareProviderRequest({ mode: "none" }, snapshot(), "unused");
  assert.equal(
    (await requestProviderPlan(none, { fetchImpl: async () => (calls += 1) })).plan,
    null,
  );
  assert.equal(calls, 0);

  const prepared = prepareProviderRequest(
    { mode: "ollama", origin: "http://127.0.0.1:11434", model: "local" },
    snapshot(),
    "Group research tabs",
  );
  await assert.rejects(requestProviderPlan(prepared, { fetchImpl: async () => (calls += 1) }), {
    code: "PROVIDER_CONSENT_REQUIRED",
  });
  assert.equal(calls, 0);
});

test("provider sends the previewed body and returns only a validated editable plan", async () => {
  const data = snapshot();
  data.revision = "revision-provider";
  const prepared = prepareProviderRequest(
    {
      mode: "openai-compatible",
      origin: "https://planner.example",
      model: "planner",
    },
    data,
    "Move Alpha",
  );
  let sentBody;
  const fetchImpl = async (_url, init) => {
    sentBody = init.body;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                explanation: "A local suggestion",
                operations: [
                  {
                    id: "move-provider",
                    type: "move_tabs",
                    tabIds: ["tab-a"],
                    targetSpaceId: "space-b",
                    targetFolderId: null,
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const result = await requestProviderPlan(prepared, { approved: true, fetchImpl });
  assert.equal(sentBody, prepared.serializedBody);
  assert.equal(sentBody.includes("https://example.com/path"), false);
  assert.equal(result.plan.source, "ai");
  assert.equal(validatePlan(result.plan, data).ok, true);
});

test("provider rejects multiple objects, model closes, and oversized output", async () => {
  assert.throws(() => extractOneJsonObject('{"a":1} {"b":2}'), {
    code: "PROVIDER_OUTPUT_INVALID",
  });
  const data = snapshot();
  data.revision = "revision-provider-bad";
  const prepared = prepareProviderRequest(
    { mode: "ollama", origin: "http://127.0.0.1:11434", model: "local" },
    data,
    "Close old tabs",
  );
  const closeResponse = async () =>
    new Response(
      JSON.stringify({
        operations: [{ id: "close-provider", type: "close_tabs", tabIds: ["tab-a"] }],
      }),
      { status: 200 },
    );
  await assert.rejects(
    requestProviderPlan(prepared, { approved: true, fetchImpl: closeResponse }),
    { code: "PROVIDER_OUTPUT_INVALID" },
  );
  const oversized = async () =>
    new Response("{}", { status: 200, headers: { "content-length": "1048577" } });
  await assert.rejects(
    requestProviderPlan(prepared, { approved: true, fetchImpl: oversized }),
    { code: "PROVIDER_RESPONSE_TOO_LARGE" },
  );
});

test("provider timeouts redact output and unavailable secure storage keeps no token", async () => {
  const data = snapshot();
  data.revision = "revision-provider-timeout";
  const prepared = prepareProviderRequest(
    { mode: "ollama", origin: "http://127.0.0.1:11434", model: "local" },
    data,
    "Plan",
  );
  const hangingFetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
    );
  await assert.rejects(
    requestProviderPlan(prepared, { approved: true, fetchImpl: hangingFetch, timeoutMs: 1 }),
    { code: "PROVIDER_TIMEOUT" },
  );
  const invalidFetch = async () => new Response('{"private-title":"Never echo me"}', { status: 200 });
  await assert.rejects(
    requestProviderPlan(prepared, { approved: true, fetchImpl: invalidFetch }),
    error => error.code === "PROVIDER_OUTPUT_INVALID" && !error.message.includes("Never echo me"),
  );
  assert.equal(
    await saveProviderToken("https://planner.example", "secret", { Services: { logins: {} } }),
    false,
  );
});

test("clear organizer data removes only organizer state and credentials", async () => {
  const removed = [];
  let preferenceCleared = false;
  const zenState = { tabs: 300, spaces: 10 };
  const browserWindow = {
    Services: {
      prefs: { clearUserPref: key => (preferenceCleared = key === "zen.organizer.state") },
      logins: {
        searchLoginsAsync: async () => [{ username: "one" }, { username: "two" }],
        removeLoginAsync: async login => removed.push(login.username),
      },
    },
    gBrowser: zenState,
  };
  assert.deepEqual(await clearOrganizerData(browserWindow), {
    credentialsRemoved: 2,
    credentialError: false,
  });
  assert.equal(preferenceCleared, true);
  assert.deepEqual(removed, ["one", "two"]);
  assert.deepEqual(browserWindow.gBrowser, zenState);
});

test("only the verified Zen build can expose mutation capabilities", () => {
  assert.equal(isVerifiedZenBuild("1.21.15b", "20260818101929"), true);
  assert.equal(isVerifiedZenBuild("1.21.15b", "different-build"), false);
  assert.equal(isVerifiedZenBuild("1.22.0b", "20260818101929"), false);
});
