import { computeRevision, validateSnapshot } from "./organizer-core.mjs";

const STATE_PREF = "zen.organizer.state";
const TOKEN_ORIGIN = "https://zen-organizer.invalid";
const TOKEN_REALM = "Zen Organizer Provider Token";
const VERIFIED_ZEN_BUILDS = new Set(["1.21.15b:20260818101929"]);

export function isVerifiedZenBuild(version, buildId) {
  return VERIFIED_ZEN_BUILDS.has(`${version}:${buildId}`);
}

function organizerError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function getBrowserWindow() {
  const windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(
    Ci.nsIWindowMediator,
  );
  const browserWindow = windowMediator.getMostRecentWindow("navigator:browser");
  if (!browserWindow) throw organizerError("ZEN_API_UNAVAILABLE", "Zen window not found");
  return browserWindow;
}

export function openOrganizer(browserWindow = getBrowserWindow()) {
  const organizerUrl = "chrome://zenorganizer/content/organizer.html";
  const existing = browserWindow.gZenWorkspaces.allStoredTabs.find(
    tab => tab.linkedBrowser?.currentURI?.spec === organizerUrl,
  );
  if (existing) {
    browserWindow.gBrowser.selectedTab = existing;
    return;
  }
  browserWindow.gBrowser.selectedTab = browserWindow.gBrowser.addTab(organizerUrl, {
    triggeringPrincipal: browserWindow.Services.scriptSecurityManager.getSystemPrincipal(),
  });
}

export async function readSnapshot(browserWindow = getBrowserWindow()) {
  const { gBrowser, gZenFolders, gZenWorkspaces, SessionStore } = browserWindow;
  if (!gBrowser || !gZenWorkspaces || !SessionStore) {
    throw organizerError("ZEN_API_UNAVAILABLE", "Required Zen APIs are unavailable");
  }

  await Promise.all([
    gZenWorkspaces.promiseInitialized,
    SessionStore.promiseAllWindowsRestored,
  ]);

  const liveSpaces = gZenWorkspaces.getWorkspaces?.();
  const liveTabs = gZenWorkspaces.allStoredTabs;
  if (!Array.isArray(liveSpaces) || !Array.isArray(liveTabs)) {
    throw organizerError("SNAPSHOT_NOT_READY", "Zen session is not ready");
  }

  const spaces = liveSpaces.map((space, position) => ({
    id: String(space.uuid),
    name: String(space.name || "Space"),
    icon: typeof space.icon === "string" ? space.icon : null,
    position,
    containerId: Number(space.containerTabId) || 0,
  }));
  const spaceIds = new Set(spaces.map(space => space.id));
  const activeSpaceId = String(gZenWorkspaces.activeWorkspace || "");
  const fallbackSpaceId = spaceIds.has(activeSpaceId) ? activeSpaceId : spaces[0]?.id || "";

  const positions = new Map();
  const liveFolders = (gBrowser.tabGroups || []).filter(group => group?.isZenFolder);
  const folders = liveFolders.map(group => {
    const spaceId = String(group.getAttribute("zen-workspace-id") || "");
    const position = positions.get(spaceId) || 0;
    positions.set(spaceId, position + 1);
    return {
      id: String(group.id),
      name: String(group.label || "Folder"),
      spaceId,
      parentFolderId: group.group?.isZenFolder ? String(group.group.id) : null,
      position,
      collapsed: !!group.collapsed,
    };
  });

  const capturedAt = Date.now();
  const inventoryTabs = liveTabs.filter(
    tab =>
      tab &&
      tab !== browserWindow.FirefoxViewHandler?.tab &&
      tab.linkedBrowser?.currentURI?.spec !==
        "chrome://zenorganizer/content/organizer.html" &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-glance-tab"),
  );
  const idCounts = new Map();
  for (const tab of inventoryTabs) {
    if (tab.id) idCounts.set(tab.id, (idCounts.get(tab.id) || 0) + 1);
  }
  const tabs = inventoryTabs
    .map((tab, position) => {
      const directGroup = tab.group;
      const splitViewId = directGroup?.hasAttribute("split-view-group")
        ? String(directGroup.id)
        : null;
      const folder = directGroup?.isZenFolder
        ? directGroup
        : directGroup?.group?.isZenFolder
          ? directGroup.group
          : null;
      const url = String(tab.linkedBrowser?.currentURI?.spec || "about:blank");
      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        // Non-web URLs intentionally have no hostname.
      }
      const essential = tab.getAttribute("zen-essential") === "true";
      const reportedSpaceId = String(tab.getAttribute("zen-workspace-id") || "");
      return {
        id:
          tab.id && idCounts.get(tab.id) === 1
            ? String(tab.id)
            : `ephemeral:${capturedAt}:${position}`,
        title: String(tab.label || url),
        url,
        hostname,
        spaceId:
          essential && !spaceIds.has(reportedSpaceId) ? fallbackSpaceId : reportedSpaceId,
        folderId: folder ? String(folder.id) : null,
        containerId: Number(tab.userContextId) || 0,
        pinned: !!tab.pinned,
        essential,
        selected: !!tab.selected,
        splitViewId,
        lastAccessedAt: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
      };
    });

  const folderClass = browserWindow.customElements.get("zen-folder");
  const zenVersion = String(browserWindow.Services.appinfo.version);
  const buildId = String(browserWindow.Services.appinfo.appBuildID);
  const mutationsVerified = isVerifiedZenBuild(zenVersion, buildId);
  const snapshot = {
    schemaVersion: 1,
    revision: "",
    capturedAt,
    activeSpaceId: gZenWorkspaces.activeWorkspace || null,
    compatibility: { zenVersion, buildId, mutationsVerified },
    capabilities: {
      readAllSpaces: typeof gZenWorkspaces.getWorkspaces === "function",
      createFolder: mutationsVerified && typeof gZenFolders?.createFolder === "function",
      moveTabToSpace:
        mutationsVerified && typeof gZenWorkspaces.moveTabToWorkspace === "function",
      moveTabToFolder:
        mutationsVerified &&
        typeof folderClass?.prototype?.addTabs === "function" &&
        typeof gBrowser.ungroupTab === "function",
      renameFolder: mutationsVerified && typeof folderClass === "function",
      setPinned:
        mutationsVerified &&
        typeof gBrowser.pinTab === "function" && typeof gBrowser.unpinTab === "function",
      closeTab: mutationsVerified && typeof gBrowser.removeTab === "function",
    },
    spaces,
    folders,
    tabs,
  };

  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    throw organizerError("SNAPSHOT_NOT_READY", "Zen returned invalid live state", validation.errors);
  }
  snapshot.revision = await computeRevision(snapshot);
  return snapshot;
}

export function loadOrganizerState(browserWindow = getBrowserWindow()) {
  try {
    const value = JSON.parse(browserWindow.Services.prefs.getStringPref(STATE_PREF, ""));
    return value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function saveOrganizerState(state, browserWindow = getBrowserWindow()) {
  browserWindow.Services.prefs.setStringPref(STATE_PREF, JSON.stringify(state));
}

export function clearOrganizerState(browserWindow = getBrowserWindow()) {
  browserWindow.Services.prefs.clearUserPref(STATE_PREF);
}

export async function clearOrganizerData(browserWindow = getBrowserWindow()) {
  clearOrganizerState(browserWindow);
  let credentialsRemoved = 0;
  let credentialError = false;
  try {
    const logins = await browserWindow.Services.logins.searchLoginsAsync({
      origin: TOKEN_ORIGIN,
      httpRealm: TOKEN_REALM,
    });
    for (const login of logins) {
      await browserWindow.Services.logins.removeLoginAsync(login);
      credentialsRemoved += 1;
    }
  } catch {
    credentialError = true;
  }
  return { credentialsRemoved, credentialError };
}

async function providerLogins(providerOrigin, browserWindow) {
  if (typeof browserWindow.Services.logins.searchLoginsAsync !== "function") return null;
  const logins = await browserWindow.Services.logins.searchLoginsAsync({
    origin: TOKEN_ORIGIN,
    httpRealm: TOKEN_REALM,
  });
  return logins.filter(login => login.username === providerOrigin);
}

export async function loadProviderToken(providerOrigin, browserWindow = getBrowserWindow()) {
  try {
    const logins = await providerLogins(providerOrigin, browserWindow);
    return logins ? { token: logins[0]?.password || "", secure: true } : { token: "", secure: false };
  } catch {
    return { token: "", secure: false };
  }
}

export async function saveProviderToken(
  providerOrigin,
  token,
  browserWindow = getBrowserWindow(),
) {
  try {
    const logins = await providerLogins(providerOrigin, browserWindow);
    if (!logins) return false;
    if (!token) {
      for (const login of logins) await browserWindow.Services.logins.removeLoginAsync(login);
      return true;
    }
    const replacement = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo,
    );
    replacement.init(TOKEN_ORIGIN, null, TOKEN_REALM, providerOrigin, token, "", "");
    if (logins[0] && typeof browserWindow.Services.logins.modifyLoginAsync === "function") {
      await browserWindow.Services.logins.modifyLoginAsync(logins[0], replacement);
      for (const login of logins.slice(1)) {
        await browserWindow.Services.logins.removeLoginAsync(login);
      }
    } else if (logins.length === 0) {
      await browserWindow.Services.logins.addLoginAsync(replacement);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createLiveExecutor(browserWindow = getBrowserWindow()) {
  const liveTab = tabId => {
    const matches = browserWindow.gZenWorkspaces.allStoredTabs.filter(
      tab => String(tab?.id) === tabId,
    );
    if (matches.length !== 1) {
      throw organizerError("TAB_NOT_FOUND", "Tab ID is missing or ambiguous");
    }
    return matches[0];
  };
  const liveFolder = folderId => {
    const folder = browserWindow.gBrowser.tabGroups.find(
      group => group?.isZenFolder && String(group.id) === folderId,
    );
    if (!folder) throw organizerError("FOLDER_NOT_FOUND", "Folder ID was not found");
    return folder;
  };
  const liveSpace = spaceId => {
    const space = browserWindow.gZenWorkspaces.getWorkspaces().find(
      item => String(item.uuid) === spaceId,
    );
    if (!space) throw organizerError("ZEN_API_UNAVAILABLE", "Space ID was not found");
    return space;
  };
  const tabFolder = tab => {
    const group = tab.group;
    if (group?.isZenFolder) return group;
    return group?.group?.isZenFolder ? group.group : null;
  };

  return {
    readSnapshot: () => readSnapshot(browserWindow),

    async createFolder(operation) {
      liveSpace(operation.spaceId);
      const parent = operation.parentFolderId
        ? liveFolder(operation.parentFolderId)
        : null;
      if (parent && String(parent.getAttribute("zen-workspace-id")) !== operation.spaceId) {
        throw organizerError("FOLDER_NOT_FOUND", "Parent Folder is in another Space");
      }
      const folder = await browserWindow.gZenFolders.createFolder([], {
        workspaceId: operation.spaceId,
        label: operation.name,
        collapsed: false,
        ...(parent ? { insertAfter: parent.groupContainer.lastElementChild } : {}),
      });
      if (!folder?.id) throw organizerError("OPERATION_FAILED", "Folder creation failed");
      return { changed: true, folderId: String(folder.id) };
    },

    async renameFolder(operation) {
      const folder = liveFolder(operation.folderId);
      if (folder.label === operation.name) return { changed: false };
      folder.label = operation.name;
      folder.dispatchEvent(
        new browserWindow.CustomEvent("ZenFolderRenamed", { bubbles: true }),
      );
      return { changed: true };
    },

    async moveTab(tabId, destination) {
      liveSpace(destination.spaceId);
      let tab = liveTab(tabId);
      const currentFolder = tabFolder(tab);
      const currentSpaceId = String(tab.getAttribute("zen-workspace-id") || "");
      if (
        currentSpaceId === destination.spaceId &&
        String(currentFolder?.id || "") === String(destination.folderId || "")
      ) {
        return { changed: false };
      }
      if (currentSpaceId !== destination.spaceId) {
        await browserWindow.gZenWorkspaces.moveTabToWorkspace(tab, destination.spaceId);
        tab = liveTab(tabId);
      }
      if (destination.folderId) {
        const folder = liveFolder(destination.folderId);
        if (String(folder.getAttribute("zen-workspace-id")) !== destination.spaceId) {
          throw organizerError("FOLDER_NOT_FOUND", "Target Folder is in another Space");
        }
        if (String(tabFolder(tab)?.id || "") !== destination.folderId) {
          await folder.addTabs([tab]);
        }
      } else if (tabFolder(tab)) {
        await browserWindow.gBrowser.ungroupTab(tab);
      }
      return { changed: true };
    },

    async setPinned(tabId, pinned) {
      const tab = liveTab(tabId);
      if (!!tab.pinned === pinned) return { changed: false };
      await browserWindow.gBrowser[pinned ? "pinTab" : "unpinTab"](tab);
      return { changed: true };
    },

    async closeTab(tabId, options = {}) {
      const tab = liveTab(tabId);
      if (tab.getAttribute("zen-essential") === "true" && !options.allowEssential) {
        throw organizerError("OPERATION_FAILED", "Essential tab close was not approved");
      }
      await browserWindow.gBrowser.removeTab(tab, { animate: false });
      return { changed: true };
    },
  };
}
