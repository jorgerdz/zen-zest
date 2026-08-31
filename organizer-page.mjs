import {
  applyReviewedPlan,
  appendOperation,
  createPlan,
  daysSince,
  filterTabs,
  findExactDuplicates,
  inactivityBucket,
  newId,
  removeOperation,
  removeTabFromOperation,
  summarizeSnapshot,
  validatePlan,
} from "./organizer-core.mjs";
import {
  clearOrganizerData,
  createLiveExecutor,
  loadOrganizerState,
  loadProviderToken,
  readSnapshot,
  saveOrganizerState,
  saveProviderToken,
} from "./zen-adapter.mjs";
import { prepareProviderRequest, requestProviderPlan } from "./providers.mjs";

const elements = Object.fromEntries(
  [
    "capabilities",
    "apply-plan",
    "apply-result",
    "apply-result-list",
    "apply-result-summary",
    "clear-plan",
    "clear-organizer-data",
    "empty-state",
    "filter",
    "folder-name",
    "plan-list",
    "plan-target",
    "plan-validation",
    "preview-provider",
    "provider-consent",
    "provider-consent-row",
    "provider-mode",
    "provider-model",
    "provider-origin",
    "provider-preview",
    "provider-prompt",
    "provider-status",
    "provider-token",
    "refresh",
    "result-count",
    "search",
    "select-all",
    "selected-count",
    "snapshot-details",
    "sort",
    "spaces",
    "stage-close",
    "stage-folder",
    "stage-move",
    "stage-pin",
    "stage-rename",
    "stage-unpin",
    "status",
    "tab-list",
    "generate-plan",
    "view-title",
    "views",
  ].map(id => [id, document.getElementById(id)]),
);

const state = {
  snapshot: null,
  duplicates: [],
  plan: null,
  providerInitialized: false,
  providerRequest: null,
  selected: new Set(),
  view: { kind: "all", id: null, label: "All tabs" },
};
const sessionTokens = new Map();

function button(label, count, kind, id = "", depth = 0) {
  const item = document.createElement("button");
  item.type = "button";
  item.dataset.kind = kind;
  item.dataset.id = id;
  item.style.setProperty("--depth", depth);
  item.className = "nav-item";
  item.setAttribute(
    "aria-current",
    state.view.kind === kind && state.view.id === (id || null) ? "page" : "false",
  );

  const name = document.createElement("span");
  name.textContent = label;
  const total = document.createElement("span");
  total.textContent = String(count);
  total.className = "count";
  item.append(name, total);
  return item;
}

function renderNavigation() {
  const summary = summarizeSnapshot(state.snapshot);
  const duplicateIds = new Set(state.duplicates.flatMap(group => group.tabIds));
  const buckets = { "30+": 0, "90+": 0, "180+": 0 };
  for (const tab of state.snapshot.tabs) {
    const bucket = inactivityBucket(tab.lastAccessedAt);
    if (bucket) buckets[bucket] += 1;
  }

  elements.views.replaceChildren(
    button("All tabs", summary.total, "all"),
    button("Ungrouped", summary.ungrouped, "ungrouped"),
    button("Exact duplicates", duplicateIds.size, "duplicates"),
    button("Draft plan", state.plan?.operations.length || 0, "plan"),
    button("Not selected 30–89 days", buckets["30+"], "inactivity", "30+"),
    button("Not selected 90–179 days", buckets["90+"], "inactivity", "90+"),
    button("Not selected 180+ days", buckets["180+"], "inactivity", "180+"),
  );

  const folderSummaries = new Map(summary.folders.map(folder => [folder.id, folder]));
  const folderChildren = new Map();
  for (const folder of state.snapshot.folders) {
    const key = folder.parentFolderId || folder.spaceId;
    if (!folderChildren.has(key)) folderChildren.set(key, []);
    folderChildren.get(key).push(folder);
  }
  const fragment = document.createDocumentFragment();
  const appendFolders = (parentId, depth) => {
    for (const folder of (folderChildren.get(parentId) || []).toSorted(
      (a, b) => a.position - b.position,
    )) {
      fragment.append(
        button(
          folder.name,
          folderSummaries.get(folder.id)?.total || 0,
          "folder",
          folder.id,
          depth,
        ),
      );
      appendFolders(folder.id, depth + 1);
    }
  };
  for (const space of summary.spaces.toSorted((a, b) => a.position - b.position)) {
    fragment.append(button(space.name, space.total, "space", space.id));
    appendFolders(space.id, 1);
  }
  elements.spaces.replaceChildren(fragment);
}

function tabsForView() {
  const duplicateIds = new Set(state.duplicates.flatMap(group => group.tabIds));
  const visible = state.snapshot.tabs.filter(tab => {
    if (state.view.kind === "plan") {
      const plannedIds = new Set(
        state.plan?.operations.flatMap(operation => operation.tabIds || []) || [],
      );
      return plannedIds.has(tab.id);
    }
    if (state.view.kind === "ungrouped") return !tab.folderId;
    if (state.view.kind === "duplicates") return duplicateIds.has(tab.id);
    if (state.view.kind === "inactivity") {
      return inactivityBucket(tab.lastAccessedAt) === state.view.id;
    }
    if (state.view.kind === "space") return tab.spaceId === state.view.id;
    if (state.view.kind === "folder") return tab.folderId === state.view.id;
    return true;
  });

  return filterTabs(
    { ...state.snapshot, tabs: visible },
    {
      query: elements.search.value,
      state: elements.filter.value,
      sort: elements.sort.value,
      direction: elements.sort.value === "lastAccessed" ? "desc" : "asc",
    },
  );
}

function badge(value, className = "") {
  const item = document.createElement("span");
  item.className = `badge ${className}`.trim();
  item.textContent = value;
  return item;
}

function renderTabs() {
  const tabs = tabsForView();
  const spaces = new Map(state.snapshot.spaces.map(space => [space.id, space.name]));
  const folders = new Map(state.snapshot.folders.map(folder => [folder.id, folder.name]));
  const fragment = document.createDocumentFragment();

  for (const tab of tabs) {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    checkCell.className = "check-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(tab.id);
    checkbox.setAttribute("aria-label", `Select ${tab.title}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(tab.id);
      else state.selected.delete(tab.id);
      renderSelection(tabs);
    });
    checkCell.append(checkbox);

    const tabCell = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = tab.title;
    const host = document.createElement("small");
    host.textContent = tab.hostname || tab.url;
    const badges = document.createElement("span");
    badges.className = "badges";
    if (tab.essential) badges.append(badge("Essential", "accent"));
    else if (tab.pinned) badges.append(badge("Pinned"));
    if (tab.splitViewId) badges.append(badge("Split View"));
    tabCell.append(title, host, badges);

    const location = document.createElement("td");
    const space = document.createElement("span");
    space.textContent = spaces.get(tab.spaceId) || "Unknown Space";
    const folder = document.createElement("small");
    folder.textContent = tab.folderId ? folders.get(tab.folderId) || "Unknown Folder" : "Ungrouped";
    location.append(space, folder);

    const accessed = document.createElement("td");
    const days = daysSince(tab.lastAccessedAt);
    accessed.textContent = days === null ? "Unknown" : days === 0 ? "Today" : `${days} days ago`;
    row.append(checkCell, tabCell, location, accessed);
    fragment.append(row);
  }

  elements["tab-list"].replaceChildren(fragment);
  elements["empty-state"].hidden = tabs.length > 0;
  elements["result-count"].textContent = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;
  elements["view-title"].textContent = state.view.label;
  renderSelection(tabs);
}

function renderSelection(visibleTabs = tabsForView()) {
  elements["selected-count"].textContent = String(state.selected.size);
  const visibleSelected = visibleTabs.filter(tab => state.selected.has(tab.id)).length;
  elements["select-all"].checked = visibleTabs.length > 0 && visibleSelected === visibleTabs.length;
  elements["select-all"].indeterminate = visibleSelected > 0 && visibleSelected < visibleTabs.length;
}

function destinationOptions(draftOperations = []) {
  const foldersByParent = new Map();
  for (const folder of state.snapshot.folders) {
    const parent = folder.parentFolderId || folder.spaceId;
    if (!foldersByParent.has(parent)) foldersByParent.set(parent, []);
    foldersByParent.get(parent).push(folder);
  }

  const options = [];
  const appendFolders = (parentId, spaceName, depth) => {
    for (const folder of (foldersByParent.get(parentId) || []).toSorted(
      (a, b) => a.position - b.position,
    )) {
      options.push({
        value: `folder:${folder.id}`,
        label: `${spaceName} / ${"› ".repeat(depth)}${folder.name}`,
        spaceId: folder.spaceId,
        folderId: folder.id,
      });
      appendFolders(folder.id, spaceName, depth + 1);
    }
  };
  for (const space of state.snapshot.spaces.toSorted((a, b) => a.position - b.position)) {
    options.push({
      value: `space:${space.id}`,
      label: `${space.name} / Ungrouped`,
      spaceId: space.id,
      folderId: null,
    });
    appendFolders(space.id, space.name, 0);
  }
  for (const operation of draftOperations.filter(item => item.type === "create_folder")) {
    const space = state.snapshot.spaces.find(item => item.id === operation.spaceId);
    options.push({
      value: `ref:${operation.folderRef}`,
      label: `${space?.name || "Unknown Space"} / ${operation.name} (new)`,
      spaceId: operation.spaceId,
      folderId: null,
      folderRef: operation.folderRef,
    });
  }
  return options;
}

function fillDestinationSelect(select, options, selectedValue = select.value) {
  select.replaceChildren(
    ...options.map(destination => {
      const option = document.createElement("option");
      option.value = destination.value;
      option.textContent = destination.label;
      return option;
    }),
  );
  if (options.some(destination => destination.value === selectedValue)) {
    select.value = selectedValue;
  }
}

function selectedDestination(select = elements["plan-target"], options = destinationOptions()) {
  return options.find(destination => destination.value === select.value) || null;
}

function savePlan(plan, clearSelection = false) {
  state.plan = plan;
  saveOrganizerState({ schemaVersion: 1, ...loadOrganizerState(), draftPlan: plan });
  if (clearSelection) state.selected.clear();
  renderNavigation();
  renderPlanner();
  renderTabs();
}

function updateOperation(operationId, patch) {
  savePlan({
    ...state.plan,
    operations: state.plan.operations.map(operation =>
      operation.id === operationId ? { ...operation, ...patch } : operation,
    ),
  });
}

function operationTitle(operation) {
  if (operation.type === "create_folder") return "Create Folder";
  if (operation.type === "rename_folder") return "Rename Folder";
  if (operation.type === "move_tabs") return "Move tabs";
  if (operation.type === "close_tabs") return "Close tabs";
  if (operation.type === "set_pinned") return operation.pinned ? "Pin tabs" : "Unpin tabs";
  return operation.type;
}

function tabList(operation) {
  const tabs = new Map(state.snapshot.tabs.map(tab => [tab.id, tab]));
  const list = document.createElement("ul");
  for (const tabId of operation.tabIds || []) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = tabs.get(tabId)?.title || tabId;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name.textContent} from operation`);
    remove.addEventListener("click", () =>
      savePlan(removeTabFromOperation(state.plan, operation.id, tabId)),
    );
    item.append(name, remove);
    list.append(item);
  }
  return list;
}

function renderPlanner() {
  const targetValue = elements["plan-target"].value;
  fillDestinationSelect(elements["plan-target"], destinationOptions(), targetValue);

  const validation = validatePlan(state.plan, state.snapshot);
  if (state.plan.operations.length === 0) {
    elements["plan-validation"].textContent = "No staged changes.";
  } else if (validation.ok) {
    elements["plan-validation"].textContent = `${state.plan.operations.length} staged ${
      state.plan.operations.length === 1 ? "change" : "changes"
    }; plan is valid.`;
  } else {
    const first = validation.errors[0];
    elements["plan-validation"].textContent = `${first.code}: ${first.message}`;
  }

  const cards = state.plan.operations.map((operation, index) => {
    const card = document.createElement("article");
    card.className = `plan-card${operation.type === "close_tabs" ? " destructive" : ""}`;
    const header = document.createElement("header");
    const title = document.createElement("h4");
    title.textContent = operationTitle(operation);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${operationTitle(operation)} operation`);
    remove.addEventListener("click", () => savePlan(removeOperation(state.plan, operation.id)));
    header.append(title, remove);
    card.append(header);

    if (operation.type === "create_folder" || operation.type === "rename_folder") {
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.value = operation.name;
      input.setAttribute("aria-label", `${operationTitle(operation)} name`);
      input.addEventListener("change", () => updateOperation(operation.id, { name: input.value }));
      card.append(input);
    }
    if (operation.type === "move_tabs") {
      const priorOperations = state.plan.operations.slice(0, index);
      const options = destinationOptions(priorOperations);
      const select = document.createElement("select");
      const selectedValue = operation.targetFolderRef
        ? `ref:${operation.targetFolderRef}`
        : operation.targetFolderId
          ? `folder:${operation.targetFolderId}`
          : `space:${operation.targetSpaceId}`;
      fillDestinationSelect(select, options, selectedValue);
      select.setAttribute("aria-label", "Move destination");
      select.addEventListener("change", () => {
        const destination = selectedDestination(select, options);
        if (!destination) return;
        updateOperation(operation.id, {
          targetSpaceId: destination.spaceId,
          targetFolderId: destination.folderId,
          ...(destination.folderRef
            ? { targetFolderRef: destination.folderRef }
            : { targetFolderRef: undefined }),
        });
      });
      card.append(select);
    }
    if (operation.tabIds) card.append(tabList(operation));
    return card;
  });
  elements["plan-list"].replaceChildren(...cards);
  elements["apply-plan"].disabled = !validation.ok || state.plan.operations.length === 0;
  renderActionAvailability();
  renderApplyResult(loadOrganizerState()?.lastApplyResult);
}

function renderActionAvailability() {
  const capabilities = state.snapshot.capabilities;
  const destination = selectedDestination();
  elements["stage-move"].disabled =
    !capabilities.moveTabToSpace || (!!destination?.folderId && !capabilities.moveTabToFolder);
  elements["stage-folder"].disabled = !capabilities.createFolder;
  elements["stage-rename"].disabled = !capabilities.renameFolder;
  elements["stage-pin"].disabled = !capabilities.setPinned;
  elements["stage-unpin"].disabled = !capabilities.setPinned;
  elements["stage-close"].disabled = !capabilities.closeTab;
}

async function clearData() {
  if (!window.confirm("Clear all Zen Organizer data? Zen tabs and Spaces will not change.")) return;
  const result = await clearOrganizerData();
  sessionTokens.clear();
  state.plan = createPlan(state.snapshot);
  state.providerRequest = null;
  state.providerInitialized = false;
  elements["provider-mode"].value = "none";
  elements["provider-origin"].value = "http://127.0.0.1:11434";
  elements["provider-model"].value = "";
  elements["provider-token"].value = "";
  elements["provider-prompt"].value = "";
  elements["provider-preview"].hidden = true;
  elements["provider-consent-row"].hidden = true;
  elements["provider-consent"].checked = false;
  elements["generate-plan"].disabled = true;
  initializeProviderControls();
  renderNavigation();
  renderTabs();
  renderPlanner();
  elements.status.textContent = result.credentialError
    ? "Organizer settings cleared, but saved-token cleanup failed. Remove the Zen Organizer login manually."
    : `Organizer data cleared${
        result.credentialsRemoved ? `, including ${result.credentialsRemoved} saved token` : ""
      }. Zen state was untouched.`;
}

function renderApplyResult(result) {
  elements["apply-result"].hidden = !result;
  if (!result) return;
  const counts = { completed: 0, failed: 0, not_run: 0 };
  for (const action of result.actions || []) counts[action.status] += 1;
  elements["apply-result-summary"].textContent = `${result.status}: ${counts.completed} completed, ${counts.failed} failed, ${counts.not_run} not run.`;
  elements["apply-result-list"].replaceChildren(
    ...(result.actions || []).map(action => {
      const item = document.createElement("li");
      const target = action.tabId || action.folderId || action.folderRef || action.operationId;
      item.textContent = `${action.type} · ${target} · ${action.status}${
        action.code ? ` (${action.code})` : ""
      }`;
      return item;
    }),
  );
}

function providerConfig() {
  return {
    mode: elements["provider-mode"].value,
    origin: elements["provider-origin"].value,
    model: elements["provider-model"].value,
  };
}

function persistProviderSettings(extra = {}) {
  const stored = loadOrganizerState() || {};
  saveOrganizerState({
    schemaVersion: 1,
    ...stored,
    provider: providerConfig(),
    ...extra,
  });
}

function updateProviderControls() {
  const enabled = elements["provider-mode"].value !== "none";
  for (const id of ["provider-origin", "provider-model", "provider-token", "provider-prompt"]) {
    elements[id].disabled = !enabled;
  }
  elements["preview-provider"].disabled = !enabled;
  if (!enabled) {
    elements["provider-status"].textContent = "Provider is disabled; no network request can run.";
  }
}

function initializeProviderControls() {
  if (state.providerInitialized) return;
  const provider = loadOrganizerState()?.provider;
  if (["none", "ollama", "openai-compatible"].includes(provider?.mode)) {
    elements["provider-mode"].value = provider.mode;
  }
  if (provider?.origin) elements["provider-origin"].value = provider.origin;
  if (provider?.model) elements["provider-model"].value = provider.model;
  state.providerInitialized = true;
  updateProviderControls();
}

function resetProviderPreview() {
  state.providerRequest = null;
  elements["provider-preview"].hidden = true;
  elements["provider-consent-row"].hidden = true;
  elements["provider-consent"].checked = false;
  elements["generate-plan"].disabled = true;
  persistProviderSettings();
  updateProviderControls();
}

function previewProvider() {
  try {
    const prepared = prepareProviderRequest(
      providerConfig(),
      state.snapshot,
      elements["provider-prompt"].value,
    );
    state.providerRequest = prepared;
    elements["provider-preview"].textContent = JSON.stringify(prepared.preview, null, 2);
    elements["provider-preview"].hidden = false;
    if (prepared.mode === "none") {
      elements["provider-status"].textContent = "Provider is disabled; no request will run.";
      return;
    }
    const consents = loadOrganizerState()?.providerConsents || {};
    elements["provider-consent-row"].hidden = false;
    elements["provider-consent"].checked = consents[prepared.consentKey] === true;
    elements["generate-plan"].disabled = !elements["provider-consent"].checked;
    elements["provider-status"].textContent = prepared.lanHttp
      ? "Review the exact JSON body. This LAN endpoint uses unencrypted HTTP."
      : "Review the exact JSON body before approving disclosure.";
    persistProviderSettings();
  } catch (error) {
    state.providerRequest = null;
    elements["generate-plan"].disabled = true;
    elements["provider-status"].textContent = `${error.code || "PROVIDER_OUTPUT_INVALID"}: ${error.message}`;
  }
}

function setProviderConsent() {
  const prepared = state.providerRequest;
  if (!prepared || prepared.mode === "none") return;
  if (
    elements["provider-consent"].checked &&
    prepared.lanHttp &&
    !window.confirm("Send tab metadata over unencrypted HTTP to this private-LAN endpoint?")
  ) {
    elements["provider-consent"].checked = false;
  }
  const stored = loadOrganizerState() || {};
  const providerConsents = { ...(stored.providerConsents || {}) };
  providerConsents[prepared.consentKey] = elements["provider-consent"].checked;
  persistProviderSettings({ providerConsents });
  elements["generate-plan"].disabled = !elements["provider-consent"].checked;
}

async function generateProviderPlan() {
  const prepared = state.providerRequest;
  if (!prepared || !elements["provider-consent"].checked) return;
  if (
    state.plan.operations.length &&
    !window.confirm("Replace the current draft with the generated plan?")
  ) {
    return;
  }
  elements["generate-plan"].disabled = true;
  elements["provider-status"].textContent = "Waiting for provider…";
  try {
    let token = elements["provider-token"].value || sessionTokens.get(prepared.origin) || "";
    let secure = !sessionTokens.has(prepared.origin);
    if (elements["provider-token"].value) {
      secure = await saveProviderToken(prepared.origin, token);
      if (!secure) sessionTokens.set(prepared.origin, token);
      elements["provider-token"].value = "";
    } else if (!token) {
      const stored = await loadProviderToken(prepared.origin);
      token = stored.token;
      secure = stored.secure;
    }
    const generated = await requestProviderPlan(prepared, { approved: true, token });
    savePlan(generated.plan);
    elements["provider-status"].textContent = `${generated.plan.operations.length} generated changes are ready for review.${
      generated.explanation ? ` ${generated.explanation}` : ""
    }${token && !secure ? " Token is memory-only for this session." : ""}`;
  } catch (error) {
    elements["provider-status"].textContent = `${error.code || "PROVIDER_UNREACHABLE"}: ${error.message}`;
  } finally {
    elements["generate-plan"].disabled = !elements["provider-consent"].checked;
  }
}

async function applyPlan() {
  if (!window.confirm(`Apply ${state.plan.operations.length} reviewed changes to Zen?`)) return;
  const hasCloses = state.plan.operations.some(operation => operation.type === "close_tabs");
  let closesApproved = !hasCloses;
  if (hasCloses && !window.confirm("Close the reviewed tabs? Zen Undo Close Tab can recover them.")) {
    return;
  }
  closesApproved = true;
  elements["apply-plan"].disabled = true;
  elements.status.textContent = "Running preflight…";
  let result;
  try {
    result = await applyReviewedPlan(state.plan, createLiveExecutor(), {
      approved: true,
      closesApproved,
    });
  } catch (error) {
    result = {
      schemaVersion: 1,
      planId: state.plan.id,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status: "failed",
      code: error.code || "OPERATION_FAILED",
      actions: [],
    };
  }
  saveOrganizerState({
    schemaVersion: 1,
    ...loadOrganizerState(),
    draftPlan: state.plan,
    lastApplyResult: result,
  });
  if (result.status === "complete") {
    state.plan = { ...state.plan, operations: [] };
    await refresh();
    saveOrganizerState({
      schemaVersion: 1,
      ...loadOrganizerState(),
      draftPlan: state.plan,
      lastApplyResult: result,
    });
    renderPlanner();
  } else {
    await refresh();
  }
  elements.status.textContent =
    result.status === "complete"
      ? "Apply complete. Inventory refreshed."
      : `${result.code}: ${
          result.actions.filter(action => action.status === "completed").length
        } completed; remaining actions did not run.`;
}

function stageTabOperation(type, details = {}) {
  const tabIds = [...state.selected];
  if (tabIds.length === 0) {
    elements["plan-validation"].textContent = "Select at least one tab first.";
    return;
  }
  savePlan(
    appendOperation(state.plan, { id: newId("operation"), type, tabIds, ...details }),
    true,
  );
}

function renderDetails(elapsed) {
  const details = {
    Tabs: state.snapshot.tabs.length,
    Spaces: state.snapshot.spaces.length,
    Folders: state.snapshot.folders.length,
    Zen: state.snapshot.compatibility.zenVersion,
    Mutations: state.snapshot.compatibility.mutationsVerified ? "Verified" : "Read-only",
    Revision: state.snapshot.revision.slice(0, 10),
  };
  const detailNodes = [];
  for (const [name, value] of Object.entries(details)) {
    const term = document.createElement("dt");
    term.textContent = name;
    const description = document.createElement("dd");
    description.textContent = String(value);
    detailNodes.push(term, description);
  }
  elements["snapshot-details"].replaceChildren(...detailNodes);

  const labels = {
    readAllSpaces: "Read all Spaces",
    createFolder: "Create Folders",
    moveTabToSpace: "Move between Spaces",
    moveTabToFolder: "Move into Folders",
    renameFolder: "Rename Folders",
    setPinned: "Pin and unpin",
    closeTab: "Close tabs",
  };
  const capabilities = Object.entries(state.snapshot.capabilities).map(([key, available]) => {
    const item = document.createElement("li");
    item.textContent = `${available ? "Available" : "Unavailable"}: ${labels[key]}`;
    item.className = available ? "available" : "unavailable";
    return item;
  });
  elements.capabilities.replaceChildren(...capabilities);
  elements.status.textContent = state.snapshot.compatibility.mutationsVerified
    ? `Refreshed in ${Math.round(elapsed)} ms`
    : `Read-only: Zen ${state.snapshot.compatibility.zenVersion} build ${state.snapshot.compatibility.buildId} is not verified.`;
}

function setView(target) {
  const labels = {
    all: "All tabs",
    ungrouped: "Ungrouped tabs",
    duplicates: "Exact duplicates",
    plan: "Tabs in draft plan",
    inactivity: `Inactive ${target.dataset.id} days`,
    space: target.firstElementChild.textContent,
    folder: target.firstElementChild.textContent,
  };
  state.view = {
    kind: target.dataset.kind,
    id: target.dataset.id || null,
    label: labels[target.dataset.kind],
  };
  renderNavigation();
  renderTabs();
}

async function refresh() {
  const started = performance.now();
  elements.refresh.disabled = true;
  elements.status.textContent = "Reading Zen…";
  try {
    state.snapshot = await readSnapshot();
    state.duplicates = findExactDuplicates(state.snapshot);
    initializeProviderControls();
    if (!state.plan) {
      const savedPlan = loadOrganizerState()?.draftPlan;
      state.plan = Array.isArray(savedPlan?.operations) ? savedPlan : createPlan(state.snapshot);
    } else if (state.plan.operations.length === 0) {
      state.plan = createPlan(state.snapshot);
    }
    const liveIds = new Set(state.snapshot.tabs.map(tab => tab.id));
    state.selected = new Set([...state.selected].filter(id => liveIds.has(id)));
    renderNavigation();
    renderTabs();
    renderPlanner();
    renderDetails(performance.now() - started);
  } catch (error) {
    elements.status.textContent = `${error.code || "SNAPSHOT_NOT_READY"}: ${error.message}`;
  } finally {
    elements.refresh.disabled = false;
  }
}

for (const container of [elements.views, elements.spaces]) {
  container.addEventListener("click", event => {
    const target = event.target.closest("button[data-kind]");
    if (target) setView(target);
  });
}
for (const control of [elements.search, elements.filter, elements.sort]) {
  control.addEventListener("input", () => renderTabs());
}
elements["select-all"].addEventListener("change", () => {
  for (const tab of tabsForView()) {
    if (elements["select-all"].checked) state.selected.add(tab.id);
    else state.selected.delete(tab.id);
  }
  renderTabs();
});
elements["stage-move"].addEventListener("click", () => {
  const destination = selectedDestination();
  if (!destination) return;
  stageTabOperation("move_tabs", {
    targetSpaceId: destination.spaceId,
    targetFolderId: destination.folderId,
  });
});
elements["stage-pin"].addEventListener("click", () =>
  stageTabOperation("set_pinned", { pinned: true }),
);
elements["stage-unpin"].addEventListener("click", () =>
  stageTabOperation("set_pinned", { pinned: false }),
);
elements["stage-close"].addEventListener("click", () => stageTabOperation("close_tabs"));
elements["stage-folder"].addEventListener("click", () => {
  const name = elements["folder-name"].value.replace(/\s+/g, " ").trim();
  const destination = selectedDestination();
  if (!name || !destination) {
    elements["plan-validation"].textContent = "Enter a Folder name and choose its location.";
    return;
  }
  const folderRef = newId("folder");
  let plan = appendOperation(state.plan, {
    id: newId("operation"),
    type: "create_folder",
    folderRef,
    name,
    spaceId: destination.spaceId,
    parentFolderId: destination.folderId,
  });
  if (state.selected.size) {
    plan = appendOperation(plan, {
      id: newId("operation"),
      type: "move_tabs",
      tabIds: [...state.selected],
      targetSpaceId: destination.spaceId,
      targetFolderId: null,
      targetFolderRef: folderRef,
    });
  }
  elements["folder-name"].value = "";
  savePlan(plan, true);
});
elements["stage-rename"].addEventListener("click", () => {
  const name = elements["folder-name"].value.replace(/\s+/g, " ").trim();
  const destination = selectedDestination();
  if (!name || !destination?.folderId) {
    elements["plan-validation"].textContent = "Enter a name and choose an existing Folder.";
    return;
  }
  elements["folder-name"].value = "";
  savePlan(
    appendOperation(state.plan, {
      id: newId("operation"),
      type: "rename_folder",
      folderId: destination.folderId,
      name,
    }),
  );
});
elements["clear-plan"].addEventListener("click", () => savePlan(createPlan(state.snapshot)));
elements["clear-organizer-data"].addEventListener("click", clearData);
elements["plan-target"].addEventListener("change", renderActionAvailability);
elements["apply-plan"].addEventListener("click", applyPlan);
for (const id of ["provider-mode", "provider-origin", "provider-model", "provider-token", "provider-prompt"]) {
  elements[id].addEventListener("input", resetProviderPreview);
}
elements["preview-provider"].addEventListener("click", previewProvider);
elements["provider-consent"].addEventListener("change", setProviderConsent);
elements["generate-plan"].addEventListener("click", generateProviderPlan);
elements.refresh.addEventListener("click", refresh);

refresh();
