(() => {
  "use strict";

  if (globalThis.__CBWNativeAppLoaded) return;
  globalThis.__CBWNativeAppLoaded = true;
  const CBW = globalThis.__CBWNative;
  if (!CBW?.storage || !CBW?.adapter || !CBW?.model || !CBW?.graphPanel || !CBW?.folding) {
    console.error("Chat Branch Workspace: 原生增强模块加载不完整。");
    return;
  }

  let scope = CBW.util.pathKey();
  let state = CBW.storage.load(scope);
  let preferences = CBW.storage.loadPreferences();
  let bindings = new Map();
  let scanTimer = 0;
  let nativeMode = document.documentElement.dataset.cbwViewMode !== "workspace";
  let lastRenderSignature = "";
  let lastComposerCapture = { hash: "", at: 0 };
  let historyLoading = false;
  let locateGeneration = 0;

  function save() {
    CBW.storage.save(state);
  }

  function renderSignature() {
    return JSON.stringify({
      activeNodeId: state.activeNodeId,
      attachmentNodeId: state.attachmentNodeId,
      activeFocusId: state.activeFocusId,
      displayMode: state.displayMode,
      panelCollapsed: state.panelCollapsed,
      focuses: state.focuses.map((focus) => [focus.id, focus.name, focus.targetNodeId]),
      nodes: state.nodes.map((node) => [node.id, node.parentId, node.title, node.status])
    });
  }

  function render(force = false) {
    const signature = renderSignature();
    if (force || signature !== lastRenderSignature) {
      panel.render(state);
      lastRenderSignature = signature;
    }
  }

  function activeFocusIds() {
    return new Set(CBW.model.activeFocusPath(state).map((node) => node.id));
  }

  function applyPathFilter() {
    const visible = activeFocusIds();
    bindings.forEach((round, nodeId) => {
      const hidden = nativeMode && state.displayMode === "focus" && !visible.has(nodeId);
      [round.user?.element, round.assistant?.element].forEach((element) => {
        if (!element) return;
        element.dataset.cbwNodeId = nodeId;
        element.classList.toggle("cbw-native-turn-hidden", hidden);
      });
      [round.user?.content, round.assistant?.content].forEach((content) => {
        if (content) content.dataset.cbwNodeContentId = nodeId;
      });
    });
  }

  function statusText(result) {
    if (!state.nodes.length) {
      const info = CBW.adapter.diagnostics();
      const candidates = info.explicitTurns + info.roleNodes + info.mainArticles + info.messageIds + info.labeledTurns;
      return candidates
        ? "发现消息候选，但尚未配对为一轮问答；页面更新后会继续重试。"
        : "尚未识别到 ChatGPT 原生消息 DOM；请刷新页面或更新适配器。";
    }
    const focus = CBW.model.activeFocus(state);
    const pathSize = CBW.model.activeFocusPath(state).length;
    if (result?.added?.length) return `已加入 ${result.added.length} 个节点；挂载点已推进到新节点。`;
    if (CBW.adapter.isGenerating()) return "ChatGPT 正在生成；图节点会自动更新。";
    return state.displayMode === "focus" && focus
      ? `专注“${focus.name}” · 显示路径 ${pathSize} 轮`
      : `显示全部 ${state.nodes.length} 轮 · 挂载关系只影响本地图`;
  }

  function clearRoundBindings() {
    document.querySelectorAll("[data-cbw-node-id]").forEach((element) => {
      delete element.dataset.cbwNodeId;
      element.classList.remove("cbw-native-turn-hidden");
    });
    document.querySelectorAll("[data-cbw-node-content-id]").forEach((element) => delete element.dataset.cbwNodeContentId);
  }

  function scanNow() {
    clearTimeout(scanTimer);
    scanTimer = 0;
    const previousData = JSON.stringify(state.nodes.map((node) => [node.id, node.userKey, node.assistantKey, node.assistantHash, node.status]));
    const rounds = CBW.adapter.collectRounds();
    const result = CBW.model.reconcileRounds(state, rounds);
    clearRoundBindings();
    bindings = result.bindings;
    applyPathFilter();
    CBW.folding.enhance(state, bindings, save);
    const nextData = JSON.stringify(state.nodes.map((node) => [node.id, node.userKey, node.assistantKey, node.assistantHash, node.status]));
    if (previousData !== nextData || result.added.length) save();
    render();
    panel.setStatus(statusText(result));
    if (!historyLoading) panel.setHistoryState(CBW.adapter.historyBoundary(rounds));
  }

  function scheduleScan(delay = 180) {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanNow, delay);
  }

  function composerText() {
    const composer = CBW.adapter.findComposer();
    if (!composer) return "";
    return CBW.adapter.normalizeText(
      composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : (composer.innerText || composer.textContent || "")
    );
  }

  function captureComposerSend() {
    if (!nativeMode) return;
    const text = composerText();
    if (!text) return;
    const hash = CBW.adapter.hashText(text);
    const time = Date.now();
    if (lastComposerCapture.hash === hash && time - lastComposerCapture.at < 1200) return;
    lastComposerCapture = { hash, at: time };
    const node = CBW.model.capturePendingUser(state, text);
    if (!node) return;
    save();
    render(true);
    applyPathFilter();
    panel.setStatus("已捕获发送内容，正在等待 ChatGPT 原生回复节点。");
    scheduleScan(80);
  }

  function revealBoundNode(nodeId) {
    const round = bindings.get(nodeId);
    const target = round?.user?.content
      || round?.user?.element
      || round?.assistant?.content
      || round?.assistant?.element
      || document.querySelector(`[data-cbw-node-content-id="${CSS.escape(nodeId)}"], [data-cbw-node-id="${CSS.escape(nodeId)}"]`);
    if (target) {
      document.querySelectorAll(".cbw-native-turn-located").forEach((element) => element.classList.remove("cbw-native-turn-located"));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.add("cbw-native-turn-located");
        window.setTimeout(() => target.classList.remove("cbw-native-turn-located"), 1800);
      }));
      panel.setStatus("已定位到该轮问题的开头。");
      return true;
    }
    return false;
  }

  function nodePosition(node) {
    if (Number.isFinite(node?.turnOrdinal)) return node.turnOrdinal;
    if (Number.isFinite(node?.order)) return node.order;
    return state.nodes.indexOf(node);
  }

  function seekDirection(nodeId) {
    const target = CBW.model.nodeById(state, nodeId);
    const targetPosition = nodePosition(target);
    const visiblePositions = [...bindings.keys()]
      .map((id) => CBW.model.nodeById(state, id))
      .filter(Boolean)
      .map(nodePosition);
    if (!visiblePositions.length) return 1;
    if (targetPosition < Math.min(...visiblePositions)) return -1;
    if (targetPosition > Math.max(...visiblePositions)) return 1;
    const nearest = visiblePositions.reduce((best, position) => Math.abs(position - targetPosition) < Math.abs(best - targetPosition) ? position : best);
    return targetPosition < nearest ? -1 : 1;
  }

  async function locateNode(nodeId) {
    const generation = ++locateGeneration;
    scanNow();
    if (revealBoundNode(nodeId)) return;
    const container = CBW.adapter.findConversationScrollContainer();
    if (!container) {
      panel.setStatus("未找到 ChatGPT 的对话滚动区域，无法继续定位。");
      return;
    }
    let unchanged = 0;
    let previousSignature = "";
    const startedAt = Date.now();
    for (let step = 0; step < 80 && Date.now() - startedAt < 60000; step += 1) {
      if (generation !== locateGeneration || !CBW.model.nodeById(state, nodeId)) return;
      scanNow();
      if (revealBoundNode(nodeId)) return;
      const direction = seekDirection(nodeId);
      const distance = Math.max(container.clientHeight * 0.85, 520);
      const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextTop = Math.max(0, Math.min(maximum, container.scrollTop + direction * distance));
      const signature = `${container.scrollTop}:${container.scrollHeight}:${[...bindings.keys()].join(",")}`;
      unchanged = signature === previousSignature ? unchanged + 1 : 0;
      previousSignature = signature;
      if (nextTop === container.scrollTop && unchanged >= 2) break;
      panel.setStatus(`正在${direction > 0 ? "向后" : "向前"}查找目标对话…`);
      const changed = waitForDomChange(container, 700);
      container.scrollTo({ top: nextTop, behavior: "auto" });
      await changed;
    }
    scanNow();
    if (!revealBoundNode(nodeId)) panel.setStatus("已检查当前对话的可加载范围，仍未找到该节点对应的原生消息。");
  }

  function waitForDomChange(target, timeout = 1000) {
    return new Promise((resolve) => {
      let complete = false;
      const done = () => {
        if (complete) return;
        complete = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(done);
      observer.observe(target === document.scrollingElement ? document.body : target, { childList: true, subtree: true, characterData: true });
      const timer = window.setTimeout(done, timeout);
    });
  }

  function snapshotRound(round) {
    const copy = (turn) => turn ? {
      role: turn.role,
      text: turn.text,
      hash: turn.hash,
      sourceKey: turn.sourceKey,
      searchKey: turn.searchKey,
      ordinal: turn.ordinal,
      index: turn.index
    } : null;
    return { user: copy(round.user), assistant: copy(round.assistant) };
  }

  function observeHistoryRounds(session, rounds) {
    const keys = rounds.map((round) => round.user.sourceKey);
    rounds.forEach((round) => session.rounds.set(round.user.sourceKey, snapshotRound(round)));
    if (!session.order.length) {
      session.order = [...keys];
      return;
    }
    const overlap = keys.findIndex((key) => session.order.includes(key));
    if (overlap < 0) {
      session.order = [...keys.filter((key) => !session.order.includes(key)), ...session.order];
      return;
    }
    const anchorIndex = session.order.indexOf(keys[overlap]);
    session.order.splice(anchorIndex, 0, ...keys.slice(0, overlap).filter((key) => !session.order.includes(key)));
    let previous = keys[overlap];
    keys.slice(overlap + 1).forEach((key) => {
      if (!session.order.includes(key)) session.order.splice(session.order.indexOf(previous) + 1, 0, key);
      previous = key;
    });
  }

  async function loadHistoricalMessages() {
    if (historyLoading) return;
    if (CBW.adapter.isGenerating()) {
      panel.setStatus("当前回复仍在生成，请完成后再加载历史消息。");
      return;
    }
    const initialRounds = CBW.adapter.collectRounds();
    const initialBoundary = CBW.adapter.historyBoundary(initialRounds);
    if (!initialBoundary.hasEarlier) {
      panel.setHistoryState(initialBoundary);
      panel.setStatus(initialBoundary.known ? "历史消息已经全部加载。" : "当前页面没有确认到可加载的更早消息。");
      return;
    }
    const container = CBW.adapter.findConversationScrollContainer();
    if (!container) {
      panel.setStatus("未找到 ChatGPT 的对话滚动区域。");
      return;
    }

    historyLoading = true;
    panel.setHistoryState({ hasEarlier: true, known: true, loading: true });
    const pageAtStart = scope;
    const visibleAnchor = initialRounds.map((round) => round.user).find((turn) => turn.content.getBoundingClientRect().bottom > 0)
      || initialRounds[0]?.user;
    const anchorKey = visibleAnchor?.sourceKey || "";
    const anchorTop = visibleAnchor?.content.getBoundingClientRect().top || 0;
    const session = { rounds: new Map(), order: [] };
    let previousSize = 0;
    let unchanged = 0;
    let completedBoundary = initialBoundary;
    const startedAt = Date.now();

    try {
      for (let step = 0; step < 80 && Date.now() - startedAt < 60000; step += 1) {
        if (scope !== pageAtStart) throw new Error("PAGE_CHANGED");
        const rounds = CBW.adapter.collectRounds();
        observeHistoryRounds(session, rounds);
        const size = session.rounds.size;
        unchanged = size === previousSize ? unchanged + 1 : 0;
        previousSize = size;
        completedBoundary = CBW.adapter.historyBoundary(rounds);
        panel.setStatus(`正在加载历史消息：已识别 ${size} 轮`);
        if (!completedBoundary.hasEarlier) break;
        if (container.scrollTop <= 1 && unchanged >= 3) break;

        const nativeControl = completedBoundary.control;
        const changed = waitForDomChange(container);
        if (nativeControl) nativeControl.click();
        const distance = Math.max(container.clientHeight * 0.85, 520);
        container.scrollTo({ top: Math.max(0, container.scrollTop - distance), behavior: "auto" });
        await changed;
      }

      const finalRounds = CBW.adapter.collectRounds();
      observeHistoryRounds(session, finalRounds);
      completedBoundary = CBW.adapter.historyBoundary(finalRounds);
      const ordered = session.order.map((key) => session.rounds.get(key)).filter(Boolean);
      const result = CBW.model.importEarlierRounds(state, ordered);
      if (result.added.length) save();
      scanNow();
      const complete = !completedBoundary.hasEarlier && completedBoundary.known;
      panel.setStatus(complete
        ? `历史消息已全部加载；新增 ${result.added.length} 个节点。`
        : `本次新增 ${result.added.length} 个节点；页面仍提示可能有更早消息，可再次加载。`);
    } catch (error) {
      panel.setStatus(error?.message === "PAGE_CHANGED" ? "页面地址已变化，历史加载已停止。" : "历史消息加载失败，可稍后重试。");
      console.warn("Chat Branch Workspace: 加载历史消息失败。", error);
    } finally {
      historyLoading = false;
      const anchor = CBW.adapter.collectRounds().map((round) => round.user).find((turn) => turn.sourceKey === anchorKey);
      if (anchor) {
        const delta = anchor.content.getBoundingClientRect().top - anchorTop;
        container.scrollTo({ top: Math.max(0, container.scrollTop + delta), behavior: "auto" });
      }
      panel.setHistoryState(CBW.adapter.historyBoundary());
      scheduleScan(100);
    }
  }

  const panel = CBW.graphPanel.createPanel({
    onCollapse() {
      state.panelCollapsed = !state.panelCollapsed;
      save();
      render(true);
    },
    onShowAll() {
      CBW.model.showAll(state);
      save();
      render(true);
      applyPathFilter();
      panel.setStatus(statusText());
    },
    onSetAttachment(nodeId) {
      if (!CBW.model.setAttachment(state, nodeId)) return;
      save();
      render(true);
      panel.setStatus("已设置挂载点；下一轮问答将接在此节点下。发送后挂载点会自动推进。");
      CBW.adapter.findComposer()?.focus();
    },
    onToggleFocus(nodeId) {
      const existing = CBW.model.focusesAtNode(state, nodeId)[0];
      if (existing) {
        const removed = CBW.model.removeFocusAtNode(state, nodeId);
        if (!removed.length) return;
        save();
        render(true);
        applyPathFilter();
        panel.setStatus(`已删除专注“${existing.name}”。`);
        return;
      }
      const focus = CBW.model.createFocus(state, nodeId);
      if (!focus) return;
      save();
      render(true);
      panel.setStatus(`已创建专注“${focus.name}”；双击名称可以修改。`);
    },
    onLoadHistory() {
      loadHistoricalMessages();
    },
    onCycleTheme() {
      const modes = ["auto", "light", "dark"];
      preferences.themeMode = modes[(modes.indexOf(preferences.themeMode) + 1) % modes.length];
      CBW.storage.savePreferences(preferences);
      panel.setThemeMode(preferences.themeMode);
    },
    onSelectFocus(focusId) {
      if (!CBW.model.selectFocus(state, focusId)) return;
      const focus = CBW.model.activeFocus(state);
      save();
      render(true);
      applyPathFilter();
      if (focus) locateNode(focus.targetNodeId);
    },
    onSelectNode(nodeId) {
      if (!CBW.model.selectNode(state, nodeId)) return;
      save();
      render(true);
      locateNode(nodeId);
    },
    onRenameNode(nodeId, name) {
      if (!CBW.model.renameNode(state, nodeId, name)) return;
      save();
      render(true);
      panel.setStatus("节点名称已更新；原始对话内容未改变。");
    },
    onRenameFocus(focusId, name) {
      if (!CBW.model.renameFocus(state, focusId, name)) return;
      save();
      render(true);
      panel.setStatus("专注名称已更新。");
    },
    onMoveNode(sourceId, targetId) {
      const result = CBW.model.moveNode(state, sourceId, targetId);
      if (!result.ok) {
        panel.setStatus("不能把节点移动到自己或自己的后代下。");
        render(true);
        return;
      }
      save();
      render(true);
      applyPathFilter();
      panel.setStatus(result.removedFocuses.length
        ? `已移动子树，并删除 ${result.removedFocuses.length} 个路径已改变的专注；节点定位保持不变。`
        : "已移动子树；节点定位保持不变，ChatGPT 后端上下文不会改变。");
    }
  });

  function clearNativeDecorations() {
    document.querySelectorAll(".cbw-native-turn-hidden").forEach((element) => element.classList.remove("cbw-native-turn-hidden"));
    document.querySelectorAll(".cbw-native-fold-hidden").forEach((element) => element.classList.remove("cbw-native-fold-hidden"));
    document.querySelectorAll("[data-cbw-native-ui]").forEach((element) => element.remove());
    document.querySelectorAll("[data-cbw-fold-ready]").forEach((element) => delete element.dataset.cbwFoldReady);
    document.querySelectorAll("[data-cbw-node-id]").forEach((element) => delete element.dataset.cbwNodeId);
    document.querySelectorAll("[data-cbw-node-content-id]").forEach((element) => delete element.dataset.cbwNodeContentId);
  }

  function switchScopeIfNeeded() {
    const nextScope = CBW.util.pathKey();
    if (nextScope === scope) return;
    locateGeneration += 1;
    clearNativeDecorations();
    state = CBW.storage.moveScope(scope, nextScope, state);
    scope = nextScope;
    bindings = new Map();
    lastRenderSignature = "";
    render(true);
    scheduleScan(350);
  }

  window.addEventListener("cbw:view-mode", (event) => {
    nativeMode = event.detail?.mode !== "workspace";
    panel.setNativeMode(nativeMode);
    if (nativeMode) {
      applyPathFilter();
      scheduleScan(50);
    } else {
      document.querySelectorAll(".cbw-native-turn-hidden").forEach((element) => element.classList.remove("cbw-native-turn-hidden"));
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.closest?.("#cbw-root, #cbw-native-root")) return;
    const composer = CBW.adapter.findComposer();
    if (composer && event.target.contains?.(composer)) captureComposerSend();
  }, true);
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("#cbw-root, #cbw-native-root")) return;
    const button = event.target.closest?.("button[data-testid='send-button'], button[data-testid='composer-send-button'], form button[aria-label*='Send'], form button[aria-label*='发送']");
    if (button) captureComposerSend();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const composer = CBW.adapter.findComposer();
    if (composer && (event.target === composer || composer.contains?.(event.target))) captureComposerSend();
  }, true);

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => mutation.target.closest?.("#cbw-root, #cbw-native-root"))) return;
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.setInterval(switchScopeIfNeeded, 500);

  panel.setNativeMode(nativeMode);
  panel.setThemeMode(preferences.themeMode);
  render(true);
  scheduleScan(50);
})();
