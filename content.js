(() => {
  "use strict";

  if (window.__chatBranchWorkspaceLoaded) return;
  window.__chatBranchWorkspaceLoaded = true;

  const STORAGE_PREFIX = "chatBranchWorkspace:v2:";
  const VIEW_MODE_KEY = `${STORAGE_PREFIX}viewMode`;
  const RECORDS_KEY = `${STORAGE_PREFIX}records`;
  const md = window.markdownit({ html: false, linkify: true, breaks: true });
  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();
  const currentPath = () => location.pathname.replace(/\/$/, "") || "/";
  function projectContext(path = currentPath()) {
    const match = path.match(/^\/g\/(g-p-[^/]+)(?:\/(.*))?$/);
    if (!match) return null;
    const rootPath = `/g/${match[1]}/project`;
    const remainder = (match[2] || "").replace(/\/$/, "");
    const isLanding = remainder === "project" || remainder === "";
    return { rootPath, isLanding, childPath: isLanding ? null : path };
  }
  const scopeKeyForPath = (path) => projectContext(path)?.rootPath || path;
  const storageKeyFor = (key) => `${STORAGE_PREFIX}conversation:${key}`;

  let currentPageKey = currentPath();
  let currentScopeKey = scopeKeyForPath(currentPageKey);
  let storageKey = storageKeyFor(currentScopeKey);
  let pendingCapture = null;
  let captureTimer = 0;
  let routeCandidate = currentPageKey;
  let routeCandidateSince = Date.now();
  let archiveViewScopeKey = null;

  function initialState() {
    const rootId = uid("branch");
    return {
      version: 2,
      activeBranchId: rootId,
      activeNodeId: null,
      branches: [{ id: rootId, parentId: null, name: "Overall", remotePath: null, createdAt: now() }],
      nodes: [],
      messages: []
    };
  }

  function loadState(key = storageKey) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed?.version === 2 && parsed.branches?.length && Array.isArray(parsed.nodes)) return parsed;
    } catch (error) {
      console.warn("Chat Branch Workspace: 无法读取本地数据。", error);
    }
    return initialState();
  }

  let state = loadState();
  const host = document.createElement("div");
  host.id = "cbw-root";
  host.innerHTML = `
    <div class="cbw-app" role="application" aria-label="Chat Branch Workspace">
      <aside class="cbw-sidebar">
        <div class="cbw-sidebar-head">
          <button class="cbw-exit" type="button" aria-label="退出工作台">←</button>
          <div><strong>Chat Branch</strong><span>Conversation graph</span></div>
        </div>
        <button class="cbw-new" type="button">＋ 新建 branch</button>
        <nav class="cbw-tree" aria-label="Branch 与对话节点"></nav>
        <section class="cbw-record-library">
          <div class="cbw-record-heading"><span>本地对话记录</span><em class="cbw-record-count">0</em></div>
          <div class="cbw-records"></div>
        </section>
        <div class="cbw-local-note"><span></span><b class="cbw-sync-label">等待新对话</b></div>
      </aside>
      <main class="cbw-main">
        <header class="cbw-topbar">
          <div><span class="cbw-kicker">CURRENT BRANCH</span><h1 class="cbw-title"></h1></div>
          <div class="cbw-top-actions"><button class="cbw-return-page" type="button" hidden>返回当前网页</button><button class="cbw-rename" type="button">重命名 branch</button></div>
        </header>
        <section class="cbw-messages" aria-live="polite"></section>
        <form class="cbw-composer">
          <label class="cbw-sr-only" for="cbw-input">输入 Markdown 消息</label>
          <textarea id="cbw-input" rows="1" placeholder="使用 Markdown 继续聊天…" required></textarea>
          <button type="submit">发送 <span>↵</span></button>
          <p class="cbw-composer-status">Enter 发送到 ChatGPT · Shift + Enter 换行</p>
        </form>
      </main>
    </div>
    <button class="cbw-fab" type="button" aria-label="切换到 ChatGPT 原界面" title="切换到 ChatGPT 原界面">
      <span class="cbw-fab-icon" aria-hidden="true">⑂</span><span class="cbw-fab-label">原界面</span>
    </button>`;
  document.documentElement.appendChild(host);

  const $ = (selector) => host.querySelector(selector);
  const treeEl = $(".cbw-tree");
  const messagesEl = $(".cbw-messages");
  const titleEl = $(".cbw-title");
  const inputEl = $("#cbw-input");
  const appEl = $(".cbw-app");
  const fabEl = $(".cbw-fab");
  const statusEl = $(".cbw-composer-status");
  const syncLabelEl = $(".cbw-sync-label");
  const recordsEl = $(".cbw-records");
  const recordCountEl = $(".cbw-record-count");
  const returnPageEl = $(".cbw-return-page");

  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(RECORDS_KEY)) || []; }
    catch { return []; }
  }

  function recordTitle() {
    const firstNode = state.nodes[0];
    const rootBranch = state.branches.find((branch) => branch.parentId === null);
    return firstNode?.title || rootBranch?.name || "未命名对话";
  }

  function updateRecordIndex() {
    if (!state.nodes.length || archiveViewScopeKey) return;
    const records = loadRecords();
    const existing = records.find((record) => record.scopeKey === currentScopeKey);
    const value = {
      scopeKey: currentScopeKey,
      lastPath: currentPageKey,
      title: recordTitle(),
      nodeCount: state.nodes.length,
      updatedAt: now(),
      isProject: Boolean(projectContext(currentPageKey))
    };
    if (existing) Object.assign(existing, value);
    else records.push(value);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  }

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(state));
    updateRecordIndex();
  }
  function activeBranch() { return state.branches.find((branch) => branch.id === state.activeBranchId); }
  function branchNodes(branchId) { return state.nodes.filter((node) => node.branchId === branchId); }
  function messageById(id) { return state.messages.find((message) => message.id === id); }
  function promptName(label, current = "") {
    const value = window.prompt(label, current);
    return value === null ? null : value.trim().slice(0, 80);
  }

  function makeTurnTitle(content) {
    const plain = content
      .replace(/```[\s\S]*?```/g, "代码问题")
      .replace(/[#>*_`~\[\]()]/g, " ")
      .replace(/https?:\/\/\S+/g, "链接")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) return "新问题";
    return plain.length > 30 ? `${plain.slice(0, 30)}…` : plain;
  }

  function syncProjectBranchToPath(path, allowCreate = true) {
    const context = projectContext(path);
    if (!context?.childPath) return;
    let branch = state.branches.find((item) => item.remotePath === context.childPath);
    if (!branch && pendingCapture) {
      branch = activeBranch();
      if (branch) branch.remotePath = context.childPath;
    }
    if (!branch && allowCreate) {
      const shortId = context.childPath.split("/").at(-1).slice(0, 10);
      branch = {
        id: uid("branch"), parentId: null, name: `对话 ${shortId}`,
        remotePath: context.childPath, createdAt: now()
      };
      state.branches.push(branch);
    }
    if (branch) state.activeBranchId = branch.id;
  }

  function setViewMode(mode) {
    const workspace = mode !== "original";
    appEl.classList.toggle("cbw-app-hidden", !workspace);
    fabEl.classList.toggle("cbw-original-active", !workspace);
    fabEl.querySelector(".cbw-fab-label").textContent = workspace ? "原界面" : "分支界面";
    const label = workspace ? "切换到 ChatGPT 原界面" : "切换到分支工作台";
    fabEl.setAttribute("aria-label", label);
    fabEl.title = label;
    localStorage.setItem(VIEW_MODE_KEY, workspace ? "workspace" : "original");
  }

  function renderRecords() {
    const records = loadRecords();
    recordCountEl.textContent = String(records.length);
    recordsEl.replaceChildren();
    if (!records.length) {
      const empty = document.createElement("span");
      empty.className = "cbw-record-empty";
      empty.textContent = "完成一次对话后自动保存";
      recordsEl.appendChild(empty);
      return;
    }
    records.forEach((record) => {
      const row = document.createElement("div");
      row.className = `cbw-record${record.scopeKey === (archiveViewScopeKey || currentScopeKey) ? " active" : ""}`;
      row.dataset.scopeKey = record.scopeKey;
      row.innerHTML = `<button type="button" class="cbw-record-view"><strong></strong><span></span></button><button type="button" class="cbw-record-open" title="打开原网页" aria-label="打开原网页">↗</button>`;
      row.querySelector("strong").textContent = record.title;
      row.querySelector(".cbw-record-view span").textContent = `${record.isProject ? "项目" : "对话"} · ${record.nodeCount} 个节点`;
      row.querySelector(".cbw-record-open").dataset.path = record.lastPath;
      recordsEl.appendChild(row);
    });
  }

  function renderTree() {
    treeEl.replaceChildren();
    const appendBranches = (parentId, depth) => {
      state.branches.filter((branch) => branch.parentId === parentId).forEach((branch, index, siblings) => {
        const branchButton = document.createElement("button");
        branchButton.type = "button";
        branchButton.className = `cbw-branch${branch.id === state.activeBranchId ? " active" : ""}`;
        branchButton.style.setProperty("--depth", depth);
        branchButton.dataset.branchId = branch.id;
        if (branch.remotePath) branchButton.title = branch.remotePath;
        branchButton.innerHTML = `<span class="cbw-lines">${depth ? (index === siblings.length - 1 ? "└─" : "├─") : ""}</span><i></i><span></span>`;
        branchButton.lastElementChild.textContent = branch.name;
        treeEl.appendChild(branchButton);

        branchNodes(branch.id).forEach((node, nodeIndex) => {
          const row = document.createElement("div");
          row.className = `cbw-node-row${node.id === state.activeNodeId ? " active" : ""}`;
          row.style.setProperty("--depth", depth + 1);
          row.dataset.nodeId = node.id;
          row.innerHTML = `<button type="button" class="cbw-node"><span class="cbw-node-path">${nodeIndex === branchNodes(branch.id).length - 1 ? "└─" : "├─"}</span><i></i><span class="cbw-node-name"></span><em></em></button><button type="button" class="cbw-node-rename" title="重命名节点" aria-label="重命名节点">✎</button>`;
          row.querySelector(".cbw-node-name").textContent = node.title;
          row.querySelector("em").textContent = node.status === "waiting" ? "…" : "✓";
          treeEl.appendChild(row);
        });
        appendBranches(branch.id, depth + 1);
      });
    };
    appendBranches(null, 0);
  }

  function renderMessage(message, node) {
    const article = document.createElement("article");
    article.className = `cbw-message cbw-${message.role}`;
    article.dataset.nodeId = node?.id || "";
    const meta = document.createElement("div");
    meta.className = "cbw-message-meta";
    meta.textContent = message.role === "user" ? "YOU" : "ASSISTANT";
    article.appendChild(meta);
    if (message.role === "user" && node) {
      const heading = document.createElement("h2");
      heading.className = "cbw-turn-title";
      heading.textContent = node.title;
      article.appendChild(heading);
    }
    const body = document.createElement("div");
    body.className = "cbw-markdown";
    body.innerHTML = md.render(message.content);
    body.querySelectorAll("a").forEach((link) => { link.target = "_blank"; link.rel = "noopener noreferrer"; });
    article.appendChild(body);
    messagesEl.appendChild(article);
  }

  function renderMessages() {
    messagesEl.replaceChildren();
    const nodes = branchNodes(state.activeBranchId);
    if (!nodes.length) {
      const empty = document.createElement("div");
      empty.className = "cbw-empty";
      empty.innerHTML = "<strong>这个 branch 还没有对话节点</strong><span>发送第一条消息后会自动创建节点。</span>";
      messagesEl.appendChild(empty);
      return;
    }
    nodes.forEach((node) => {
      const user = messageById(node.userMessageId);
      const assistant = messageById(node.assistantMessageId);
      if (user) renderMessage(user, node);
      if (assistant) renderMessage(assistant, node);
      else {
        const waiting = document.createElement("div");
        waiting.className = "cbw-response-waiting";
        waiting.dataset.nodeId = node.id;
        waiting.textContent = node.status === "error" ? "未能同步回复，请切回原界面检查。" : "正在等待 ChatGPT 回复…";
        messagesEl.appendChild(waiting);
      }
    });
    requestAnimationFrame(() => {
      const selected = state.activeNodeId && messagesEl.querySelector(`[data-node-id="${CSS.escape(state.activeNodeId)}"]`);
      if (selected) selected.scrollIntoView({ block: "start" });
      else messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function render() {
    const branch = activeBranch();
    if (!branch) return;
    titleEl.textContent = branch.name;
    const context = projectContext(currentPageKey);
    syncLabelEl.textContent = archiveViewScopeKey ? "正在查看本地副本" : pendingCapture
      ? (context?.isLanding ? "等待项目跳转后绑定" : "正在同步回复")
      : `已绑定 ${context ? "当前项目" : (currentPageKey === "/" ? "新对话" : currentPageKey)}`;
    renderTree();
    renderMessages();
    save();
    renderRecords();
    returnPageEl.hidden = !archiveViewScopeKey;
    $(".cbw-composer button[type='submit']").disabled = Boolean(archiveViewScopeKey);
    inputEl.disabled = Boolean(archiveViewScopeKey);
    inputEl.placeholder = archiveViewScopeKey ? "本地副本为只读；请先打开原网页" : "使用 Markdown 继续聊天…";
  }

  function openLocalRecord(scopeKey) {
    const key = storageKeyFor(scopeKey);
    const saved = localStorage.getItem(key);
    if (!saved) return;
    archiveViewScopeKey = scopeKey;
    pendingCapture = null;
    currentScopeKey = scopeKey;
    storageKey = key;
    state = loadState(key);
    render();
  }

  function returnToCurrentPage() {
    archiveViewScopeKey = null;
    currentPageKey = currentPath();
    currentScopeKey = scopeKeyForPath(currentPageKey);
    storageKey = storageKeyFor(currentScopeKey);
    state = loadState();
    syncProjectBranchToPath(currentPageKey);
    render();
  }

  function addBranch() {
    const name = promptName("新 branch 名称", "New branch");
    if (!name) return;
    const branchId = uid("branch");
    state.branches.push({ id: branchId, parentId: state.activeBranchId, name, remotePath: null, createdAt: now() });
    state.activeBranchId = branchId;
    state.activeNodeId = null;
    render();
    const context = projectContext(currentPageKey);
    if (context && !context.isLanding) location.assign(context.rootPath);
    inputEl.focus();
  }

  function findOriginalComposer() {
    return ["#prompt-textarea", "textarea[data-id='root']", "form textarea", "form div[contenteditable='true']"]
      .map((selector) => document.querySelector(selector))
      .find((element) => element && !host.contains(element));
  }

  function fillOriginalComposer(editor, content) {
    editor.focus({ preventScroll: true });
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(editor, content);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, content);
      if (!(editor.textContent || "").trim()) editor.textContent = content;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: content }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function assistantElements() {
    const selectors = [
      "[data-message-author-role='assistant']",
      "article[data-turn='assistant']",
      "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']"
    ];
    const unique = new Set();
    selectors.forEach((selector) => document.querySelectorAll(selector).forEach((element) => {
      if (!host.contains(element)) unique.add(element);
    }));
    return [...unique];
  }

  function extractAssistantText(element) {
    const content = element.querySelector(".markdown, [class*='markdown'], [data-message-content]") || element;
    return (content.innerText || content.textContent || "").trim();
  }

  function isGenerating() {
    return Boolean(document.querySelector("button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']"));
  }

  function checkForReply() {
    if (!pendingCapture) return;
    const elements = assistantElements();
    const latest = elements.at(-1);
    const text = latest ? extractAssistantText(latest) : "";
    if (!text || (elements.length <= pendingCapture.baselineCount && text === pendingCapture.baselineText)) return;
    if (text !== pendingCapture.lastText) {
      pendingCapture.lastText = text;
      pendingCapture.stableSince = Date.now();
      statusEl.textContent = "正在同步 ChatGPT 回复…";
      return;
    }
    if (isGenerating() || Date.now() - pendingCapture.stableSince < 1200) return;
    const node = state.nodes.find((item) => item.id === pendingCapture.nodeId);
    if (!node) { pendingCapture = null; return; }
    const message = { id: uid("msg"), nodeId: node.id, branchId: node.branchId, role: "assistant", content: text, createdAt: now() };
    state.messages.push(message);
    node.assistantMessageId = message.id;
    node.status = "complete";
    pendingCapture = null;
    statusEl.textContent = "回复已同步 · Enter 继续提问";
    render();
  }

  function beginCapture(nodeId, resumeAfterNavigation = false) {
    const existing = assistantElements();
    pendingCapture = {
      nodeId,
      baselineCount: resumeAfterNavigation ? 0 : existing.length,
      baselineText: resumeAfterNavigation ? "" : (existing.length ? extractAssistantText(existing.at(-1)) : ""),
      lastText: "",
      stableSince: Date.now()
    };
    clearInterval(captureTimer);
    captureTimer = window.setInterval(checkForReply, 450);
  }

  async function sendToOriginalChatGPT(content) {
    const editor = findOriginalComposer();
    if (!editor) throw new Error("未找到 ChatGPT 输入框，请切回原界面后刷新页面。");
    fillOriginalComposer(editor, content);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const button = [
      "button[data-testid='send-button']", "button[data-testid='composer-send-button']",
      "form button[aria-label*='Send']", "form button[aria-label*='发送']"
    ].map((selector) => document.querySelector(selector)).find((element) => element && !host.contains(element) && !element.disabled);
    if (!button) throw new Error("已填入原输入框，但发送键暂不可用。请切回原界面检查。");
    button.click();
  }

  function switchConversationIfNeeded() {
    if (archiveViewScopeKey) return;
    const nextPageKey = currentPath();
    if (nextPageKey === currentPageKey) {
      routeCandidate = nextPageKey;
      routeCandidateSince = Date.now();
      return;
    }
    if (nextPageKey !== routeCandidate) {
      routeCandidate = nextPageKey;
      routeCandidateSince = Date.now();
      return;
    }
    if (Date.now() - routeCandidateSince < 600) return;
    const previousKey = currentPageKey;
    const previousScopeKey = currentScopeKey;
    const previousStorageKey = storageKey;
    const previousProject = projectContext(previousKey);
    const nextProject = projectContext(nextPageKey);
    currentPageKey = nextPageKey;
    routeCandidate = nextPageKey;
    routeCandidateSince = Date.now();
    currentScopeKey = scopeKeyForPath(currentPageKey);
    storageKey = storageKeyFor(currentScopeKey);

    if (previousProject && nextProject && previousProject.rootPath === nextProject.rootPath) {
      syncProjectBranchToPath(nextPageKey);
      save();
      render();
      return;
    }

    const isNewConversationAssignment = previousKey === "/" && nextPageKey.startsWith("/c/") && state.nodes.length > 0;
    if (isNewConversationAssignment) {
      localStorage.setItem(storageKey, JSON.stringify(state));
      localStorage.removeItem(previousStorageKey);
    } else if (previousScopeKey !== currentScopeKey) {
      pendingCapture = null;
      state = loadState();
      syncProjectBranchToPath(nextPageKey);
    }
    render();
  }

  treeEl.addEventListener("click", (event) => {
    const renameButton = event.target.closest(".cbw-node-rename");
    const nodeRow = event.target.closest(".cbw-node-row");
    if (renameButton && nodeRow) {
      const node = state.nodes.find((item) => item.id === nodeRow.dataset.nodeId);
      const name = node && promptName("重命名对话节点", node.title);
      if (name) { node.title = name; render(); }
      return;
    }
    if (nodeRow) {
      const node = state.nodes.find((item) => item.id === nodeRow.dataset.nodeId);
      if (node) { state.activeBranchId = node.branchId; state.activeNodeId = node.id; render(); }
      return;
    }
    const branchButton = event.target.closest(".cbw-branch");
    if (branchButton) {
      const branch = state.branches.find((item) => item.id === branchButton.dataset.branchId);
      if (!branch) return;
      state.activeBranchId = branch.id;
      state.activeNodeId = null;
      render();
      const context = projectContext(currentPageKey);
      if (context && !archiveViewScopeKey) {
        const targetPath = branch.remotePath || context.rootPath;
        if (targetPath !== currentPageKey) location.assign(targetPath);
      }
    }
  });

  recordsEl.addEventListener("click", (event) => {
    const row = event.target.closest(".cbw-record");
    if (!row) return;
    const openButton = event.target.closest(".cbw-record-open");
    if (openButton) {
      archiveViewScopeKey = null;
      location.assign(openButton.dataset.path);
      return;
    }
    openLocalRecord(row.dataset.scopeKey);
  });

  $(".cbw-new").addEventListener("click", addBranch);
  $(".cbw-rename").addEventListener("click", () => {
    const branch = activeBranch();
    const name = promptName("重命名 branch", branch.name);
    if (name) { branch.name = name; render(); }
  });
  returnPageEl.addEventListener("click", returnToCurrentPage);
  $(".cbw-exit").addEventListener("click", () => setViewMode("original"));
  fabEl.addEventListener("click", () => setViewMode(appEl.classList.contains("cbw-app-hidden") ? "workspace" : "original"));

  $(".cbw-composer").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (archiveViewScopeKey) {
      statusEl.textContent = "本地副本为只读，请点击记录右侧 ↗ 打开原网页后继续。";
      return;
    }
    const content = inputEl.value.trim();
    if (!content || pendingCapture) return;
    const submitButton = $(".cbw-composer button[type='submit']");
    submitButton.disabled = true;
    statusEl.textContent = "正在发送到 ChatGPT…";
    const branchId = state.activeBranchId;
    const userMessage = { id: uid("msg"), branchId, role: "user", content, createdAt: now() };
    const node = {
      id: uid("node"), branchId, parentNodeId: branchNodes(branchId).at(-1)?.id || null,
      title: makeTurnTitle(content), status: "waiting", userMessageId: userMessage.id,
      assistantMessageId: null, createdAt: now()
    };
    state.messages.push(userMessage);
    state.nodes.push(node);
    state.activeNodeId = node.id;
    render();
    try {
      beginCapture(node.id);
      await sendToOriginalChatGPT(content);
      inputEl.value = "";
      inputEl.style.height = "auto";
      statusEl.textContent = "已发送，正在等待 ChatGPT 回复…";
      render();
    } catch (error) {
      pendingCapture = null;
      node.status = "error";
      render();
      statusEl.textContent = error.message;
      setTimeout(() => { statusEl.textContent = "Enter 发送到 ChatGPT · Shift + Enter 换行"; }, 5000);
    } finally {
      submitButton.disabled = false;
    }
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $(".cbw-composer").requestSubmit();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
  });

  new MutationObserver(() => { if (pendingCapture) checkForReply(); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.setInterval(switchConversationIfNeeded, 500);
  syncProjectBranchToPath(currentPageKey);
  const resumableNode = branchNodes(state.activeBranchId).findLast((node) => node.status === "waiting" && !node.assistantMessageId);
  if (resumableNode) beginCapture(resumableNode.id, true);
  render();
  setViewMode(localStorage.getItem(VIEW_MODE_KEY) === "original" ? "original" : "workspace");
})();
