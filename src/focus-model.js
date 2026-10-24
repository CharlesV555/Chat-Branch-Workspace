(() => {
  "use strict";

  const CBW = globalThis.__CBWNative ||= {};
  const { uid, now } = CBW.util;
  const nodeById = (state, id) => state.nodes.find((node) => node.id === id) || null;
  const focusById = (state, id) => state.focuses.find((focus) => focus.id === id) || null;

  function nodePath(state, nodeId) {
    const result = [];
    const seen = new Set();
    let node = nodeById(state, nodeId);
    while (node && !seen.has(node.id)) {
      result.unshift(node);
      seen.add(node.id);
      node = node.parentId ? nodeById(state, node.parentId) : null;
    }
    return result;
  }

  const activeFocus = (state) => focusById(state, state.activeFocusId);
  const activeFocusPath = (state) => {
    const focus = activeFocus(state);
    return focus ? nodePath(state, focus.targetNodeId) : [];
  };

  function roundMatchesNode(round, node) {
    if (round.user.sourceKey && node.userKey === round.user.sourceKey) return true;
    if (node.userHash !== round.user.hash) return false;
    if (round.assistant && node.assistantHash && node.assistantHash !== round.assistant.hash) return false;
    return true;
  }

  function matchRound(state, round, claimed) {
    return state.nodes.find((node) => !claimed.has(node.id) && roundMatchesNode(round, node)) || null;
  }

  function createNode(state, round, parentId, order) {
    const node = {
      id: uid("node"), parentId: parentId || null,
      title: CBW.adapter.titleFor(round.user.text),
      userKey: round.user.sourceKey, assistantKey: round.assistant?.sourceKey || null,
      userHash: round.user.hash, assistantHash: round.assistant?.hash || null,
      turnOrdinal: Number.isFinite(round.user.ordinal) ? round.user.ordinal : null,
      status: round.assistant && !CBW.adapter.isGenerating() ? "complete" : "waiting",
      order, createdAt: now()
    };
    state.nodes.push(node);
    return node;
  }

  const attachmentNode = (state) => nodeById(state, state.attachmentNodeId)
    || nodeById(state, state.activeNodeId) || state.nodes.at(-1) || null;

  function advanceAfterCreate(state, node) {
    state.attachmentNodeId = node.id;
    state.activeNodeId = node.id;
    const focus = activeFocus(state);
    if (state.displayMode === "focus" && focus) focus.targetNodeId = node.id;
  }

  function capturePendingUser(state, content) {
    const text = CBW.adapter.normalizeText(content);
    if (!text) return null;
    const userHash = CBW.adapter.hashText(text);
    const duplicate = state.nodes.findLast((node) => node.status === "waiting" && node.userHash === userHash);
    if (duplicate) return duplicate;
    const node = createNode(state, {
      user: { sourceKey: `pending:${uid("turn")}`, hash: userHash, text, ordinal: null }, assistant: null
    }, attachmentNode(state)?.id || null, state.nodes.length);
    advanceAfterCreate(state, node);
    return node;
  }

  function updateNodeFromRound(node, round) {
    node.userKey = round.user.sourceKey;
    node.userHash = round.user.hash;
    if (Number.isFinite(round.user.ordinal)) node.turnOrdinal = round.user.ordinal;
    if (round.assistant) {
      node.assistantKey = round.assistant.sourceKey;
      node.assistantHash = round.assistant.hash;
      node.status = CBW.adapter.isGenerating() ? "waiting" : "complete";
    }
  }

  function importInitialRounds(state, rounds) {
    let parentId = null;
    const added = rounds.map((round, index) => {
      const node = createNode(state, round, parentId, index);
      parentId = node.id;
      return node;
    });
    if (added.length) advanceAfterCreate(state, added.at(-1));
    return added;
  }

  function reconcileRounds(state, rounds) {
    const bindings = new Map();
    if (!rounds.length) return { bindings, added: [], updated: [] };
    if (!state.nodes.length) {
      const added = importInitialRounds(state, rounds);
      const claimed = new Set();
      rounds.forEach((round) => {
        const node = matchRound(state, round, claimed);
        if (node) { claimed.add(node.id); bindings.set(node.id, round); }
      });
      return { bindings, added, updated: [] };
    }
    const claimed = new Set();
    const matches = rounds.map((round) => {
      const node = matchRound(state, round, claimed);
      if (node) {
        claimed.add(node.id);
        updateNodeFromRound(node, round);
        bindings.set(node.id, round);
      }
      return node;
    });
    const matchedIndexes = matches.map((node, index) => node ? index : -1).filter((index) => index >= 0);
    const lastMatchedIndex = matchedIndexes.length ? Math.max(...matchedIndexes) : -1;
    const added = [];
    rounds.forEach((round, index) => {
      if (matches[index]) return;
      if (lastMatchedIndex >= 0 && index < lastMatchedIndex) return;
      if (lastMatchedIndex < 0 && state.nodes.length) return;
      const node = createNode(state, round, added.at(-1)?.id || attachmentNode(state)?.id || null, state.nodes.length);
      advanceAfterCreate(state, node);
      added.push(node);
      bindings.set(node.id, round);
    });
    return { bindings, added, updated: matches.filter(Boolean) };
  }

  function importEarlierRounds(state, rounds) {
    if (!rounds.length) return { added: [], firstMatchedIndex: -1 };
    const claimed = new Set();
    const matches = rounds.map((round) => {
      const node = matchRound(state, round, claimed);
      if (node) claimed.add(node.id);
      return node;
    });
    const firstMatchedIndex = matches.findIndex(Boolean);
    if (firstMatchedIndex <= 0) {
      matches.forEach((node, index) => { if (node) updateNodeFromRound(node, rounds[index]); });
      return { added: [], firstMatchedIndex };
    }
    const orders = state.nodes.map((node) => Number(node.order)).filter(Number.isFinite);
    const minimumOrder = orders.length ? Math.min(...orders) : 0;
    const added = [];
    let parentId = null;
    for (let index = 0; index < firstMatchedIndex; index += 1) {
      const node = createNode(state, rounds[index], parentId, minimumOrder - firstMatchedIndex + index);
      node.importedHistory = true;
      added.push(node);
      parentId = node.id;
    }
    const firstKnown = matches[firstMatchedIndex];
    if (firstKnown && !firstKnown.parentId && parentId) firstKnown.parentId = parentId;
    matches.forEach((node, index) => { if (node) updateNodeFromRound(node, rounds[index]); });
    return { added, firstMatchedIndex };
  }

  function selectNode(state, nodeId) {
    if (!nodeById(state, nodeId)) return false;
    state.activeNodeId = nodeId;
    return true;
  }

  function setAttachment(state, nodeId) {
    if (!nodeById(state, nodeId)) return false;
    state.attachmentNodeId = nodeId;
    return true;
  }

  function nextFocusName(state) {
    let number = 1;
    const names = new Set(state.focuses.map((focus) => focus.name));
    while (names.has(`专注-${number}`)) number += 1;
    return `专注-${number}`;
  }

  function createFocus(state, targetNodeId) {
    if (!nodeById(state, targetNodeId)) return null;
    const existing = state.focuses.find((focus) => focus.targetNodeId === targetNodeId);
    if (existing) return existing;
    const focus = { id: uid("focus"), name: nextFocusName(state), targetNodeId, createdAt: now() };
    state.focuses.push(focus);
    return focus;
  }

  function removeFocusAtNode(state, targetNodeId) {
    const removed = state.focuses.filter((focus) => focus.targetNodeId === targetNodeId);
    if (!removed.length) return [];
    const removedIds = new Set(removed.map((focus) => focus.id));
    state.focuses = state.focuses.filter((focus) => !removedIds.has(focus.id));
    if (removedIds.has(state.activeFocusId)) showAll(state);
    return removed;
  }

  function selectFocus(state, focusId) {
    const focus = focusById(state, focusId);
    if (!focus || !nodeById(state, focus.targetNodeId)) return false;
    state.activeFocusId = focus.id;
    state.displayMode = "focus";
    return true;
  }

  function showAll(state) {
    state.activeFocusId = null;
    state.displayMode = "all";
  }

  function renameNode(state, nodeId, name) {
    const node = nodeById(state, nodeId);
    const value = String(name || "").trim();
    if (!node || !value || value.length >= 100) return false;
    node.title = value;
    return true;
  }

  function renameFocus(state, focusId, name) {
    const focus = focusById(state, focusId);
    const value = String(name || "").trim();
    if (!focus || !value || value.length >= 100) return false;
    focus.name = value;
    return true;
  }

  function isDescendant(state, candidateId, ancestorId) {
    const seen = new Set();
    let node = nodeById(state, candidateId);
    while (node?.parentId && !seen.has(node.id)) {
      if (node.parentId === ancestorId) return true;
      seen.add(node.id);
      node = nodeById(state, node.parentId);
    }
    return false;
  }

  function subtreeIds(state, rootId) {
    const result = new Set();
    const queue = nodeById(state, rootId) ? [rootId] : [];
    while (queue.length) {
      const id = queue.shift();
      if (result.has(id)) continue;
      result.add(id);
      state.nodes.filter((node) => node.parentId === id).forEach((node) => queue.push(node.id));
    }
    return result;
  }

  function moveNode(state, sourceId, targetId) {
    const source = nodeById(state, sourceId);
    const target = nodeById(state, targetId);
    if (!source || !target || source.id === target.id || isDescendant(state, target.id, source.id)) {
      return { ok: false, removedFocuses: [] };
    }
    const movedIds = subtreeIds(state, sourceId);
    const removedFocuses = state.focuses.filter((focus) => movedIds.has(focus.targetNodeId));
    const removedIds = new Set(removedFocuses.map((focus) => focus.id));
    state.focuses = state.focuses.filter((focus) => !removedIds.has(focus.id));
    if (removedIds.has(state.activeFocusId)) showAll(state);
    source.parentId = target.id;
    return { ok: true, removedFocuses };
  }

  function tree(state) {
    const children = new Map();
    state.nodes.forEach((node) => {
      const key = node.parentId || "__root__";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node);
    });
    children.forEach((items) => items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt)));
    return children;
  }

  const focusesAtNode = (state, nodeId) => state.focuses.filter((focus) => focus.targetNodeId === nodeId);

  CBW.model = {
    nodeById, focusById, nodePath, activeFocus, activeFocusPath,
    capturePendingUser, reconcileRounds, importEarlierRounds,
    selectNode, setAttachment, createFocus, removeFocusAtNode, selectFocus, showAll,
    renameNode, renameFocus, moveNode, tree, focusesAtNode, subtreeIds
  };
})();
