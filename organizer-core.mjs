const DAY_MS = 86_400_000;
export const MAX_FOLDER_NAME_LENGTH = 200;

const text = value => String(value ?? "").toLocaleLowerCase();

export function validateSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.schemaVersion !== 1) errors.push("Unsupported snapshot schema");
  if (!Array.isArray(snapshot?.spaces)) errors.push("spaces must be an array");
  if (!Array.isArray(snapshot?.folders)) errors.push("folders must be an array");
  if (!Array.isArray(snapshot?.tabs)) errors.push("tabs must be an array");
  if (errors.length) return { ok: false, errors };

  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (!item?.id || ids.has(item.id)) errors.push(`Invalid or duplicate ${label} ID`);
      ids.add(item?.id);
    }
    return ids;
  };

  const spaceIds = unique(snapshot.spaces, "Space");
  const folderIds = unique(snapshot.folders, "Folder");
  unique(snapshot.tabs, "tab");

  for (const folder of snapshot.folders) {
    if (!spaceIds.has(folder.spaceId)) errors.push(`Unknown Space for Folder ${folder.id}`);
    if (folder.parentFolderId && !folderIds.has(folder.parentFolderId)) {
      errors.push(`Unknown parent for Folder ${folder.id}`);
    }
  }
  for (const tab of snapshot.tabs) {
    if (!spaceIds.has(tab.spaceId)) errors.push(`Unknown Space for tab ${tab.id}`);
    if (tab.folderId && !folderIds.has(tab.folderId)) {
      errors.push(`Unknown Folder for tab ${tab.id}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function computeRevision(snapshot, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("Web Crypto is unavailable");

  const tabs = snapshot.tabs
    .map(tab =>
      JSON.stringify([
        tab.id,
        tab.spaceId,
        tab.folderId,
        tab.pinned,
        tab.essential,
      ]),
    )
    .sort();
  const folders = snapshot.folders
    .map(folder =>
      JSON.stringify([
        folder.id,
        folder.spaceId,
        folder.parentFolderId,
        folder.name,
      ]),
    )
    .sort();
  const bytes = new TextEncoder().encode(
    `tabs\n${tabs.join("\n")}\nfolders\n${folders.join("\n")}`,
  );
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function daysSince(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor(Math.max(0, now - timestamp) / DAY_MS);
}

export function inactivityBucket(timestamp, now = Date.now()) {
  const days = daysSince(timestamp, now);
  if (days === null || days < 30) return null;
  if (days >= 180) return "180+";
  if (days >= 90) return "90+";
  return "30+";
}

export function filterTabs(snapshot, options = {}) {
  const spaces = new Map(snapshot.spaces.map(space => [space.id, space]));
  const folders = new Map(snapshot.folders.map(folder => [folder.id, folder]));
  const query = text(options.query).trim();
  const now = options.now ?? Date.now();

  const tabs = snapshot.tabs.filter(tab => {
    const space = spaces.get(tab.spaceId);
    const folder = folders.get(tab.folderId);
    const haystack = [tab.title, tab.hostname, space?.name, folder?.name]
      .map(text)
      .join("\n");
    if (query && !haystack.includes(query)) return false;
    if (options.spaceId && tab.spaceId !== options.spaceId) return false;
    if (options.folderId && tab.folderId !== options.folderId) return false;

    switch (options.state) {
      case "pinned":
        return tab.pinned;
      case "essential":
        return tab.essential;
      case "grouped":
        return !!tab.folderId;
      case "ungrouped":
        return !tab.folderId;
      case "inactive":
        return daysSince(tab.lastAccessedAt, now) >= 30;
      default:
        return true;
    }
  });

  const value = (tab, key) => {
    if (key === "space") return spaces.get(tab.spaceId)?.name ?? "";
    if (key === "folder") return folders.get(tab.folderId)?.name ?? "";
    if (key === "lastAccessed") return tab.lastAccessedAt ?? 0;
    return tab[key] ?? "";
  };
  const sort = options.sort ?? "title";
  const direction = options.direction === "desc" ? -1 : 1;
  return tabs.sort((a, b) => {
    const left = value(a, sort);
    const right = value(b, sort);
    const order =
      typeof left === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, {
            sensitivity: "base",
            numeric: true,
          });
    return (order || a.id.localeCompare(b.id)) * direction;
  });
}

export function normalizeDuplicateUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function findExactDuplicates(snapshot) {
  const groups = new Map();
  for (const tab of snapshot.tabs) {
    const url = normalizeDuplicateUrl(tab.url);
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(tab);
  }

  const rank = tab => [
    Number(tab.essential),
    Number(tab.pinned),
    Number(tab.selected),
    tab.lastAccessedAt ?? 0,
  ];
  const compare = (a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return a.id.localeCompare(b.id);
  };

  return [...groups.entries()]
    .filter(([, tabs]) => tabs.length > 1)
    .map(([url, tabs]) => {
      const ordered = tabs.toSorted(compare);
      return {
        url,
        keepTabId: ordered[0].id,
        duplicateTabIds: ordered.slice(1).map(tab => tab.id),
        tabIds: ordered.map(tab => tab.id),
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

export function summarizeSnapshot(snapshot, now = Date.now()) {
  const count = tabs => ({
    total: tabs.length,
    ungrouped: tabs.filter(tab => !tab.folderId).length,
    pinned: tabs.filter(tab => tab.pinned).length,
    essential: tabs.filter(tab => tab.essential).length,
    inactive: tabs.filter(tab => daysSince(tab.lastAccessedAt, now) >= 30).length,
  });

  return {
    ...count(snapshot.tabs),
    spaces: snapshot.spaces.map(space => ({
      ...space,
      ...count(snapshot.tabs.filter(tab => tab.spaceId === space.id)),
    })),
    folders: snapshot.folders.map(folder => ({
      ...folder,
      ...count(snapshot.tabs.filter(tab => tab.folderId === folder.id)),
    })),
  };
}

export function newId(prefix = "id") {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
}

export function createPlan(snapshot, options = {}) {
  return {
    schemaVersion: 1,
    id: options.id || newId("plan"),
    source: options.source || "manual",
    prompt: options.prompt ?? null,
    baseRevision: snapshot.revision,
    createdAt: options.createdAt ?? Date.now(),
    operations: [],
  };
}

export function appendOperation(plan, operation) {
  return { ...plan, operations: [...plan.operations, operation] };
}

export function removeOperation(plan, operationId) {
  return {
    ...plan,
    operations: plan.operations.filter(operation => operation.id !== operationId),
  };
}

export function removeTabFromOperation(plan, operationId, tabId) {
  const operations = plan.operations.flatMap(operation => {
    if (operation.id !== operationId || !Array.isArray(operation.tabIds)) {
      return [operation];
    }
    const tabIds = operation.tabIds.filter(id => id !== tabId);
    return tabIds.length ? [{ ...operation, tabIds }] : [];
  });
  return { ...plan, operations };
}

const operationFields = {
  create_folder: ["id", "type", "folderRef", "name", "spaceId", "parentFolderId"],
  rename_folder: ["id", "type", "folderId", "name"],
  move_tabs: [
    "id",
    "type",
    "tabIds",
    "targetSpaceId",
    "targetFolderId",
    "targetFolderRef",
  ],
  set_pinned: ["id", "type", "tabIds", "pinned"],
  close_tabs: ["id", "type", "tabIds"],
};

function planError(errors, code, message, operationId = undefined) {
  errors.push({ code, message, operationId });
}

export function validatePlan(plan, snapshot, options = {}) {
  const errors = [];
  const planFields = [
    "schemaVersion",
    "id",
    "source",
    "prompt",
    "baseRevision",
    "createdAt",
    "operations",
  ];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      ok: false,
      errors: [{ code: "INVALID_PLAN", message: "Plan must be an object" }],
      plan,
    };
  }
  for (const key of Object.keys(plan)) {
    if (!planFields.includes(key)) planError(errors, "INVALID_PLAN", `Unknown plan field: ${key}`);
  }
  if (plan.schemaVersion !== 1) planError(errors, "INVALID_PLAN", "Unsupported plan schema");
  if (!plan.id || typeof plan.id !== "string") planError(errors, "INVALID_PLAN", "Plan ID is required");
  if (!["manual", "deterministic", "ai"].includes(plan.source)) {
    planError(errors, "INVALID_PLAN", "Unknown plan source");
  }
  if (plan.prompt !== null && typeof plan.prompt !== "string") {
    planError(errors, "INVALID_PLAN", "Plan prompt must be text or null");
  }
  if (!Number.isFinite(plan.createdAt)) planError(errors, "INVALID_PLAN", "Invalid creation time");
  if (plan.baseRevision !== snapshot.revision) {
    planError(errors, "SNAPSHOT_DRIFT", "Plan was created from a different snapshot");
  }
  if (!Array.isArray(plan.operations)) {
    planError(errors, "INVALID_PLAN", "operations must be an array");
    return { ok: false, errors, plan };
  }
  if (plan.operations.length > 500) {
    planError(errors, "INVALID_PLAN", "Plan exceeds 500 operations");
  }

  const normalized = { ...plan, operations: plan.operations.map(operation => ({ ...operation })) };
  const tabs = new Map(snapshot.tabs.map(tab => [tab.id, tab]));
  const spaces = new Set(snapshot.spaces.map(space => space.id));
  const folders = new Map(snapshot.folders.map(folder => [folder.id, folder]));
  const folderRefs = new Map();
  const operationIds = new Set();
  const maxFolderDepth = options.maxFolderDepth ?? 5;
  const allowEssentials = options.allowEssentials ?? plan.source === "manual";
  let referencedTabs = 0;

  const folderDepth = folderId => {
    let depth = 0;
    let current = folders.get(folderId);
    const seen = new Set();
    while (current?.parentFolderId) {
      if (seen.has(current.id)) return Infinity;
      seen.add(current.id);
      depth += 1;
      current = folders.get(current.parentFolderId);
    }
    return depth;
  };
  const validName = (name, operationId) => {
    if (typeof name !== "string") {
      planError(errors, "INVALID_PLAN", "Folder name must be text", operationId);
      return name;
    }
    const normalizedName = name.replace(/\s+/g, " ").trim();
    if (!normalizedName || normalizedName.length > MAX_FOLDER_NAME_LENGTH) {
      planError(
        errors,
        "INVALID_PLAN",
        `Folder name must be 1–${MAX_FOLDER_NAME_LENGTH} characters`,
        operationId,
      );
    }
    return normalizedName;
  };
  const validTabIds = (tabIds, operationId) => {
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      planError(errors, "INVALID_PLAN", "Operation must reference at least one tab", operationId);
      return;
    }
    referencedTabs += tabIds.length;
    const seen = new Set();
    for (const tabId of tabIds) {
      const tab = tabs.get(tabId);
      if (typeof tabId !== "string" || seen.has(tabId)) {
        planError(errors, "INVALID_PLAN", `Duplicate or invalid tab ID: ${tabId}`, operationId);
      } else if (tabId.startsWith("ephemeral:") || !tab) {
        planError(errors, "TAB_NOT_FOUND", `Unknown or ephemeral tab: ${tabId}`, operationId);
      } else if (tab.essential && !allowEssentials) {
        planError(errors, "INVALID_PLAN", `Essential tab is excluded: ${tabId}`, operationId);
      }
      seen.add(tabId);
    }
  };
  const requireCapability = (name, operationId) => {
    if (!snapshot.capabilities[name]) {
      planError(errors, "CAPABILITY_UNAVAILABLE", `${name} is unavailable`, operationId);
    }
  };

  for (const operation of normalized.operations) {
    const operationId = operation?.id;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      planError(errors, "INVALID_PLAN", "Operation must be an object");
      continue;
    }
    if (!operationId || typeof operationId !== "string" || operationIds.has(operationId)) {
      planError(errors, "INVALID_PLAN", "Operation IDs must be unique strings", operationId);
    }
    operationIds.add(operationId);
    const allowedFields = operationFields[operation.type];
    if (!allowedFields) {
      planError(errors, "INVALID_PLAN", `Unknown operation type: ${operation.type}`, operationId);
      continue;
    }
    for (const key of Object.keys(operation)) {
      if (!allowedFields.includes(key)) {
        planError(errors, "INVALID_PLAN", `Unknown ${operation.type} field: ${key}`, operationId);
      }
    }

    if (operation.type === "create_folder") {
      requireCapability("createFolder", operationId);
      operation.name = validName(operation.name, operationId);
      if (!operation.folderRef || typeof operation.folderRef !== "string" || folderRefs.has(operation.folderRef)) {
        planError(errors, "INVALID_PLAN", "Folder reference must be a unique string", operationId);
      }
      if (!spaces.has(operation.spaceId)) {
        planError(errors, "INVALID_PLAN", `Unknown Space: ${operation.spaceId}`, operationId);
      }
      if (operation.parentFolderId !== null && !folders.has(operation.parentFolderId)) {
        planError(errors, "FOLDER_NOT_FOUND", `Unknown parent Folder: ${operation.parentFolderId}`, operationId);
      } else if (
        operation.parentFolderId &&
        folderDepth(operation.parentFolderId) + 1 >= maxFolderDepth
      ) {
        planError(errors, "INVALID_PLAN", "Folder would exceed Zen nesting depth", operationId);
      }
      folderRefs.set(operation.folderRef, {
        spaceId: operation.spaceId,
        parentFolderId: operation.parentFolderId,
      });
    } else if (operation.type === "rename_folder") {
      requireCapability("renameFolder", operationId);
      operation.name = validName(operation.name, operationId);
      if (!folders.has(operation.folderId)) {
        planError(errors, "FOLDER_NOT_FOUND", `Unknown Folder: ${operation.folderId}`, operationId);
      }
    } else if (operation.type === "move_tabs") {
      requireCapability("moveTabToSpace", operationId);
      validTabIds(operation.tabIds, operationId);
      if (!spaces.has(operation.targetSpaceId)) {
        planError(errors, "INVALID_PLAN", `Unknown target Space: ${operation.targetSpaceId}`, operationId);
      }
      if (operation.targetFolderId !== null && !folders.has(operation.targetFolderId)) {
        planError(errors, "FOLDER_NOT_FOUND", `Unknown target Folder: ${operation.targetFolderId}`, operationId);
      }
      if (operation.targetFolderId) {
        requireCapability("moveTabToFolder", operationId);
        if (folders.get(operation.targetFolderId)?.spaceId !== operation.targetSpaceId) {
          planError(errors, "INVALID_PLAN", "Target Folder is in another Space", operationId);
        }
      }
      if (operation.targetFolderRef !== undefined) {
        requireCapability("moveTabToFolder", operationId);
        const target = folderRefs.get(operation.targetFolderRef);
        if (!target) {
          planError(errors, "FOLDER_NOT_FOUND", "Folder reference must be created earlier", operationId);
        } else if (operation.targetFolderId !== null || target.spaceId !== operation.targetSpaceId) {
          planError(errors, "INVALID_PLAN", "Invalid referenced Folder destination", operationId);
        }
      }
    } else if (operation.type === "set_pinned") {
      requireCapability("setPinned", operationId);
      validTabIds(operation.tabIds, operationId);
      if (typeof operation.pinned !== "boolean") {
        planError(errors, "INVALID_PLAN", "pinned must be boolean", operationId);
      }
    } else if (operation.type === "close_tabs") {
      requireCapability("closeTab", operationId);
      validTabIds(operation.tabIds, operationId);
      if (plan.source !== "manual") {
        planError(errors, "INVALID_PLAN", "Generated plans cannot close tabs", operationId);
      }
    }
  }
  if (referencedTabs > 1_000) {
    planError(errors, "INVALID_PLAN", "Plan exceeds 1,000 referenced tabs");
  }

  return { ok: errors.length === 0, errors, plan: normalized };
}

export function orderOperations(plan) {
  const order = {
    create_folder: 0,
    rename_folder: 1,
    move_tabs: 2,
    set_pinned: 3,
    close_tabs: 4,
  };
  return {
    ...plan,
    operations: plan.operations
      .map((operation, index) => ({ operation, index }))
      .toSorted(
        (a, b) =>
          (order[a.operation.type] ?? Number.MAX_SAFE_INTEGER) -
            (order[b.operation.type] ?? Number.MAX_SAFE_INTEGER) ||
          a.index - b.index,
      )
      .map(({ operation }) => operation),
  };
}

function planActions(plan) {
  return orderOperations(plan).operations.flatMap(operation => {
    const base = { operationId: operation.id, type: operation.type };
    if (operation.type === "create_folder") {
      return [{ ...base, folderRef: operation.folderRef, operation }];
    }
    if (operation.type === "rename_folder") {
      return [{ ...base, folderId: operation.folderId, operation }];
    }
    return operation.tabIds.map(tabId => ({ ...base, tabId, operation }));
  });
}

export async function applyReviewedPlan(plan, driver, options = {}) {
  const startedAt = options.now?.() ?? Date.now();
  const finish = result => ({
    schemaVersion: 1,
    planId: plan?.id || null,
    startedAt,
    finishedAt: options.now?.() ?? Date.now(),
    ...result,
  });
  if (!options.approved) {
    return finish({ status: "rejected", code: "APPROVAL_REQUIRED", actions: [] });
  }
  if (plan?.operations?.some(operation => operation.type === "close_tabs") && !options.closesApproved) {
    return finish({ status: "rejected", code: "CLOSE_APPROVAL_REQUIRED", actions: [] });
  }

  const snapshot = await driver.readSnapshot();
  if (plan?.baseRevision !== snapshot.revision) {
    return finish({
      status: "drifted",
      code: "SNAPSHOT_DRIFT",
      baseRevision: plan?.baseRevision || null,
      currentRevision: snapshot.revision,
      actions: [],
    });
  }
  const validation = validatePlan(plan, snapshot);
  if (!validation.ok) {
    return finish({
      status: "rejected",
      code: validation.errors[0].code,
      baseRevision: plan.baseRevision,
      currentRevision: snapshot.revision,
      actions: [],
    });
  }

  const actions = planActions(validation.plan).map(action => ({
    operationId: action.operationId,
    type: action.type,
    ...(action.tabId ? { tabId: action.tabId } : {}),
    ...(action.folderId ? { folderId: action.folderId } : {}),
    ...(action.folderRef ? { folderRef: action.folderRef } : {}),
    status: "not_run",
  }));
  const folderRefs = {};
  let failed = false;
  const ordered = planActions(validation.plan);

  for (let index = 0; index < ordered.length; index += 1) {
    const action = ordered[index];
    try {
      let outcome;
      if (action.type === "create_folder") {
        outcome = await driver.createFolder(action.operation);
        if (!outcome?.folderId) {
          throw Object.assign(new Error("Created Folder could not be resolved"), {
            code: "FOLDER_NOT_FOUND",
          });
        }
        folderRefs[action.folderRef] = outcome.folderId;
      } else if (action.type === "rename_folder") {
        outcome = await driver.renameFolder(action.operation);
      } else if (action.type === "move_tabs") {
        const targetFolderId = action.operation.targetFolderRef
          ? folderRefs[action.operation.targetFolderRef]
          : action.operation.targetFolderId;
        if (action.operation.targetFolderRef && !targetFolderId) {
          throw Object.assign(new Error("Created Folder could not be resolved"), {
            code: "FOLDER_NOT_FOUND",
          });
        }
        outcome = await driver.moveTab(action.tabId, {
          spaceId: action.operation.targetSpaceId,
          folderId: targetFolderId,
        });
      } else if (action.type === "set_pinned") {
        outcome = await driver.setPinned(action.tabId, action.operation.pinned);
      } else if (action.type === "close_tabs") {
        outcome = await driver.closeTab(action.tabId, { allowEssential: plan.source === "manual" });
      }
      actions[index] = {
        ...actions[index],
        status: "completed",
        changed: outcome?.changed !== false,
        ...(outcome?.folderId ? { folderId: outcome.folderId } : {}),
      };
    } catch (error) {
      actions[index] = {
        ...actions[index],
        status: "failed",
        code: error.code || "OPERATION_FAILED",
        message: String(error.message || "Operation failed"),
      };
      failed = true;
      break;
    }
  }

  return finish({
    status: failed ? "failed" : "complete",
    code: failed ? "OPERATION_FAILED" : null,
    baseRevision: plan.baseRevision,
    currentRevision: snapshot.revision,
    folderRefs,
    actions,
  });
}
