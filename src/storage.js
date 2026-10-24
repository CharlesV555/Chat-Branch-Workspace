(() => {
  "use strict";

  const CBW = globalThis.__CBWNative ||= {};
  const PREFIX = "chatBranchWorkspace:v4:";
  const LEGACY_PREFIX = "chatBranchWorkspace:v3:";
  const PREFERENCES_KEY = `${PREFIX}preferences`;
  const LEGACY_PREFERENCES_KEY = `${LEGACY_PREFIX}preferences`;

  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();
  const pathKey = () => location.pathname.replace(/\/$/, "") || "/";
  const storageKey = (scope = pathKey()) => `${PREFIX}conversation:${scope}`;
  const legacyStorageKey = (scope = pathKey()) => `${LEGACY_PREFIX}conversation:${scope}`;

  function initialState(scope = pathKey()) {
    return {
      version: 4,
      scope,
      activeNodeId: null,
      attachmentNodeId: null,
      activeFocusId: null,
      displayMode: "all",
      panelCollapsed: false,
      nodes: [],
      focuses: [],
      folds: {}
    };
  }

  function normalizeState(value, scope) {
    if (!value || value.version !== 4 || !Array.isArray(value.nodes) || !Array.isArray(value.focuses)) return null;
    value.scope = scope;
    value.folds ||= {};
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    value.focuses = value.focuses
      .filter((focus) => focus && nodeIds.has(focus.targetNodeId))
      .map((focus) => ({ ...focus, name: String(focus.name || "专注").trim().slice(0, 99) || "专注" }));
    value.activeFocusId = value.focuses.some((focus) => focus.id === value.activeFocusId) ? value.activeFocusId : null;
    value.displayMode = value.displayMode === "focus" && value.activeFocusId ? "focus" : "all";
    value.attachmentNodeId = nodeIds.has(value.attachmentNodeId)
      ? value.attachmentNodeId
      : (nodeIds.has(value.activeNodeId) ? value.activeNodeId : value.nodes.at(-1)?.id || null);
    value.panelCollapsed = Boolean(value.panelCollapsed);
    return value;
  }

  function migrateLegacy(value, scope) {
    if (!value || value.version !== 3 || !Array.isArray(value.nodes) || !Array.isArray(value.refs)) return null;
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    const focuses = value.refs
      .filter((ref) => ref?.tipNodeId && nodeIds.has(ref.tipNodeId))
      .map((ref) => ({
        id: `focus_${ref.id}`,
        name: String(ref.name || "专注").trim().slice(0, 99) || "专注",
        targetNodeId: ref.tipNodeId,
        createdAt: ref.createdAt || now()
      }));
    const activeLegacy = value.refs.find((ref) => ref.id === value.activeRefId);
    const activeFocus = focuses.find((focus) => focus.id === `focus_${activeLegacy?.id}`) || null;
    return normalizeState({
      version: 4,
      scope,
      activeNodeId: nodeIds.has(value.activeNodeId) ? value.activeNodeId : activeLegacy?.tipNodeId || value.nodes.at(-1)?.id || null,
      attachmentNodeId: nodeIds.has(value.activeNodeId) ? value.activeNodeId : activeLegacy?.tipNodeId || value.nodes.at(-1)?.id || null,
      activeFocusId: value.filterMode === "path" ? activeFocus?.id || null : null,
      displayMode: value.filterMode === "path" && activeFocus ? "focus" : "all",
      panelCollapsed: Boolean(value.panelCollapsed),
      nodes: value.nodes,
      focuses,
      folds: value.folds || {}
    }, scope);
  }

  function load(scope = pathKey()) {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(scope)));
      const current = normalizeState(parsed, scope);
      if (current) return current;
      const legacy = migrateLegacy(JSON.parse(localStorage.getItem(legacyStorageKey(scope))), scope);
      if (legacy) {
        save(legacy);
        return legacy;
      }
      return initialState(scope);
    } catch (error) {
      console.warn("Chat Branch Workspace: 无法读取本地数据。", error);
      return initialState(scope);
    }
  }

  function save(state) {
    try {
      localStorage.setItem(storageKey(state.scope), JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn("Chat Branch Workspace: 无法保存本地数据。", error);
      return false;
    }
  }

  function moveScope(previousScope, nextScope, state) {
    if (!previousScope || previousScope === nextScope) return load(nextScope);
    const existing = localStorage.getItem(storageKey(nextScope));
    if (previousScope === "/" && !existing && state?.nodes?.length) {
      state.scope = nextScope;
      save(state);
      localStorage.removeItem(storageKey(previousScope));
      return state;
    }
    return load(nextScope);
  }

  function loadPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY))
        || JSON.parse(localStorage.getItem(LEGACY_PREFERENCES_KEY))
        || {};
      return { themeMode: ["auto", "light", "dark"].includes(value.themeMode) ? value.themeMode : "auto" };
    } catch (error) {
      console.warn("Chat Branch Workspace: 无法读取界面偏好。", error);
      return { themeMode: "auto" };
    }
  }

  function savePreferences(preferences) {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
        themeMode: ["auto", "light", "dark"].includes(preferences?.themeMode) ? preferences.themeMode : "auto"
      }));
      return true;
    } catch (error) {
      console.warn("Chat Branch Workspace: 无法保存界面偏好。", error);
      return false;
    }
  }

  CBW.util = { uid, now, pathKey };
  CBW.storage = { initialState, load, save, moveScope, storageKey, legacyStorageKey, migrateLegacy, loadPreferences, savePreferences };
})();
