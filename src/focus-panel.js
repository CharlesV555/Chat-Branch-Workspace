(() => {
  "use strict";

  const CBW = globalThis.__CBWNative ||= {};

  function createPanel(callbacks) {
    const root = document.createElement("div");
    root.id = "cbw-native-root";
    root.innerHTML = `
      <aside class="cbw-native-panel" aria-label="Chat Branch 对话图">
        <header class="cbw-native-header">
          <div><strong>Chat Branch</strong><span>LOCAL GRAPH</span></div>
          <div class="cbw-native-header-actions">
            <button type="button" class="cbw-native-theme" data-action="theme" aria-label="切换颜色模式">◐</button>
            <button type="button" class="cbw-native-collapse" data-action="collapse" aria-label="收起对话图" title="收起对话图">‹</button>
          </div>
        </header>
        <div class="cbw-native-historybar">
          <button type="button" data-action="history" disabled title="尚未确认有更早消息">加载历史消息</button>
        </div>
        <div class="cbw-native-toolbar">
          <button type="button" data-action="show-all">显示全部</button>
        </div>
        <section class="cbw-native-focuses" aria-label="专注路径"></section>
        <nav class="cbw-native-tree" aria-label="对话节点图"></nav>
        <footer class="cbw-native-status">正在读取当前对话…</footer>
      </aside>
      <button type="button" class="cbw-native-peek" data-action="collapse" aria-label="展开对话图" title="展开对话图">⑂</button>`;
    document.documentElement.appendChild(root);

    const panel = root.querySelector(".cbw-native-panel");
    const treeElement = root.querySelector(".cbw-native-tree");
    const focusesElement = root.querySelector(".cbw-native-focuses");
    const statusElement = root.querySelector(".cbw-native-status");
    const showAllButton = root.querySelector("[data-action='show-all']");
    const historyButton = root.querySelector("[data-action='history']");
    const themeButton = root.querySelector("[data-action='theme']");
    let lastState = null;
    let selectionClickTimer = 0;

    function renderFocuses(state) {
      focusesElement.replaceChildren();
      state.focuses.forEach((focus) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `cbw-native-focus${focus.id === state.activeFocusId && state.displayMode === "focus" ? " active" : ""}`;
        button.dataset.action = "focus";
        button.dataset.focusId = focus.id;
        button.title = `只显示“${focus.name}”路径；双击名称可修改`;
        const dot = document.createElement("i");
        const name = document.createElement("span");
        name.textContent = focus.name;
        name.dataset.rename = "focus";
        button.append(dot, name);
        focusesElement.appendChild(button);
      });
    }

    function circularAction(action, node, active, symbol, activeSymbol, title) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cbw-native-node-action${active ? " active" : ""}`;
      button.dataset.action = action;
      button.dataset.nodeId = node.id;
      button.textContent = active ? activeSymbol : symbol;
      button.title = title;
      button.setAttribute("aria-label", title);
      return button;
    }

    function renderTree(state) {
      treeElement.replaceChildren();
      if (!state.nodes.length) {
        const empty = document.createElement("div");
        empty.className = "cbw-native-empty";
        empty.textContent = "发送或载入一轮对话后，这里会出现节点。";
        treeElement.appendChild(empty);
        return;
      }
      const children = CBW.model.tree(state);
      const focusedIds = state.displayMode === "focus"
        ? new Set(CBW.model.activeFocusPath(state).map((node) => node.id))
        : null;
      const seen = new Set();
      const fragment = document.createDocumentFragment();

      function appendChildren(parentId, depth) {
        const key = parentId || "__root__";
        const available = (children.get(key) || []).filter((node) => !focusedIds || focusedIds.has(node.id));
        available.forEach((node, index, siblings) => {
          if (seen.has(node.id)) return;
          seen.add(node.id);
          const row = document.createElement("div");
          row.className = `cbw-native-node${node.id === state.activeNodeId ? " active" : ""}`;
          row.dataset.action = "node";
          row.dataset.nodeId = node.id;
          row.draggable = true;
          row.style.setProperty("--depth", String(depth));

          const line = document.createElement("span");
          line.className = "cbw-native-node-line";
          line.textContent = depth ? (index === siblings.length - 1 ? "└─" : "├─") : "●";
          const title = document.createElement("span");
          title.className = "cbw-native-node-title";
          title.dataset.rename = "node";
          title.textContent = node.title;
          title.title = `${node.title}；双击可修改名称`;
          const stateMark = document.createElement("em");
          stateMark.textContent = node.status === "waiting" ? "…" : "✓";
          const actions = document.createElement("span");
          actions.className = "cbw-native-node-actions";
          const attached = node.id === state.attachmentNodeId;
          const focused = CBW.model.focusesAtNode(state, node.id).length > 0;
          actions.append(
            circularAction("attach", node, attached, "◎", "●", attached ? "当前挂载点；下一轮会接在这里" : "将下一轮挂在此节点下"),
            circularAction("toggle-focus", node, focused, "☆", "★", focused ? "点击删除该节点的专注" : "为根节点到此节点的路径创建专注")
          );
          row.append(line, title, stateMark, actions);
          fragment.appendChild(row);
          appendChildren(node.id, depth + 1);
        });
      }

      appendChildren(null, 0);
      treeElement.appendChild(fragment);
      requestAnimationFrame(() => treeElement.querySelector(".cbw-native-node.active")?.scrollIntoView({ block: "nearest" }));
    }

    function render(state) {
      lastState = state;
      root.classList.toggle("collapsed", state.panelCollapsed);
      panel.setAttribute("aria-hidden", String(state.panelCollapsed));
      showAllButton.classList.toggle("active", state.displayMode === "all");
      renderFocuses(state);
      renderTree(state);
    }

    function setStatus(message) { statusElement.textContent = message; }
    function setNativeMode(enabled) { root.classList.toggle("cbw-native-mode-off", !enabled); }

    function setHistoryState({ hasEarlier = false, known = false, loading = false } = {}) {
      historyButton.disabled = !hasEarlier || loading;
      historyButton.classList.toggle("available", hasEarlier && !loading);
      historyButton.classList.toggle("loading", loading);
      historyButton.textContent = loading ? "正在加载历史消息…" : "加载历史消息";
      historyButton.title = loading ? "正在向上加载更早的原生消息"
        : hasEarlier ? "检测到当前页面之前还有未加载的消息"
          : known ? "历史消息已全部加载" : "尚未检测到可加载的更早消息";
    }

    function setThemeMode(mode = "auto") {
      const safeMode = ["auto", "light", "dark"].includes(mode) ? mode : "auto";
      root.dataset.cbwTheme = safeMode;
      const labels = { auto: "跟随浏览器", light: "白天模式", dark: "夜间模式" };
      const icons = { auto: "◐", light: "☀", dark: "☾" };
      themeButton.textContent = icons[safeMode];
      themeButton.title = `${labels[safeMode]}；点击切换`;
      themeButton.setAttribute("aria-label", `颜色模式：${labels[safeMode]}`);
    }

    function startRename(label) {
      const type = label.dataset.rename;
      const container = label.closest(type === "node" ? ".cbw-native-node" : ".cbw-native-focus");
      const id = type === "node" ? container?.dataset.nodeId : container?.dataset.focusId;
      if (!id) return;
      const original = label.textContent;
      const input = document.createElement("input");
      input.className = "cbw-native-rename";
      input.maxLength = 99;
      input.value = original;
      label.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        const value = input.value.trim();
        if (save && value && value.length < 100) {
          if (type === "node") callbacks.onRenameNode?.(id, value);
          else callbacks.onRenameFocus?.(id, value);
        } else if (input.isConnected) input.replaceWith(label);
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); finish(true); }
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true), { once: true });
      input.addEventListener("click", (event) => event.stopPropagation());
    }

    root.addEventListener("dblclick", (event) => {
      const label = event.target.closest("[data-rename]");
      if (!label) return;
      clearTimeout(selectionClickTimer);
      selectionClickTimer = 0;
      event.preventDefault();
      event.stopPropagation();
      startRename(label);
    });

    function scheduleSelection(callback) {
      clearTimeout(selectionClickTimer);
      selectionClickTimer = window.setTimeout(() => {
        selectionClickTimer = 0;
        callback();
      }, 240);
    }

    root.addEventListener("click", (event) => {
      if (event.target.closest(".cbw-native-rename")) return;
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action !== "focus" && action !== "node") {
        clearTimeout(selectionClickTimer);
        selectionClickTimer = 0;
      }
      if (action === "collapse") callbacks.onCollapse?.();
      if (action === "show-all") callbacks.onShowAll?.();
      if (action === "history") callbacks.onLoadHistory?.();
      if (action === "theme") callbacks.onCycleTheme?.();
      if (action === "focus") scheduleSelection(() => callbacks.onSelectFocus?.(target.dataset.focusId));
      if (action === "node") scheduleSelection(() => callbacks.onSelectNode?.(target.dataset.nodeId));
      if (action === "attach") callbacks.onSetAttachment?.(target.dataset.nodeId);
      if (action === "toggle-focus") callbacks.onToggleFocus?.(target.dataset.nodeId);
    });

    treeElement.addEventListener("dragstart", (event) => {
      clearTimeout(selectionClickTimer);
      selectionClickTimer = 0;
      if (event.target.closest("button,input")) { event.preventDefault(); return; }
      const row = event.target.closest(".cbw-native-node");
      if (!row) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.nodeId);
      row.classList.add("dragging");
    });
    treeElement.addEventListener("dragover", (event) => {
      const row = event.target.closest(".cbw-native-node");
      if (!row) return;
      event.preventDefault();
      treeElement.querySelectorAll(".drop-target").forEach((item) => item.classList.remove("drop-target"));
      row.classList.add("drop-target");
      event.dataTransfer.dropEffect = "move";
    });
    treeElement.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = event.target.closest(".cbw-native-node");
      const sourceId = event.dataTransfer.getData("text/plain") || treeElement.querySelector(".dragging")?.dataset.nodeId;
      treeElement.querySelectorAll(".dragging,.drop-target").forEach((item) => item.classList.remove("dragging", "drop-target"));
      if (sourceId && target) callbacks.onMoveNode?.(sourceId, target.dataset.nodeId);
    });
    treeElement.addEventListener("dragend", () => {
      treeElement.querySelectorAll(".dragging,.drop-target").forEach((item) => item.classList.remove("dragging", "drop-target"));
    });

    const colorScheme = matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener?.("change", () => { if (root.dataset.cbwTheme === "auto") setThemeMode("auto"); });
    return { root, render, setStatus, setNativeMode, setHistoryState, setThemeMode, get state() { return lastState; } };
  }

  CBW.graphPanel = { createPanel };
})();
