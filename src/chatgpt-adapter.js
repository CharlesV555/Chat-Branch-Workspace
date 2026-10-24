(() => {
  "use strict";

  const CBW = globalThis.__CBWNative ||= {};

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  const normalizeText = (text) => (text || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function roleElement(turn) {
    if (turn.matches?.("[data-message-author-role]")) return turn;
    return turn.querySelector?.("[data-message-author-role]")
      || turn.querySelector?.(":scope > h4[data-conversation-role], :scope > h5[data-conversation-role]")
      || (turn.hasAttribute?.("data-turn") ? turn : null);
  }

  function roleFor(turn) {
    const element = roleElement(turn);
    const explicit = element?.getAttribute("data-message-author-role")
      || element?.getAttribute("data-conversation-role")
      || turn.getAttribute?.("data-turn")
      || "";
    if (["user", "assistant"].includes(explicit)) return explicit;
    if (turn.querySelector?.("[data-user-message-bubble='true'], .user-message-bubble-color, [class*='user-message-bubble']")) return "user";
    const label = normalizeText(turn.querySelector?.(":scope > h4, :scope > h5, h4, h5, [class*='sr-only']")?.textContent || "").toLowerCase();
    if (/^(you said|你说|您说|用户说)/.test(label)) return "user";
    if (/^(chatgpt said|chatgpt 说|助手说)/.test(label)) return "assistant";
    if (turn.querySelector?.(".markdown, [class*='markdown'], [data-message-content]")) return "assistant";
    return "";
  }

  function contentElement(turn) {
    const role = roleElement(turn) || turn;
    const selector = ".markdown, [class*='markdown'], [data-message-content], [data-user-message-bubble='true'], .user-message-bubble-color, [class*='user-message-bubble']";
    if (/^H[1-6]$/.test(role.tagName || "") && role.nextElementSibling) {
      return role.nextElementSibling.querySelector?.(selector) || role.nextElementSibling;
    }
    return role.querySelector?.(selector) || role;
  }

  function activeConversationRoot() {
    const roots = [...document.querySelectorAll("main")]
      .filter((root) => !root.closest("#cbw-root, #cbw-native-root"))
      .filter((root) => root.querySelector("[data-thread-user-message-navigation-content], [data-message-author-role], [data-user-message-bubble='true'], h4[data-conversation-role='assistant']"));
    const visible = roots.filter((root) => {
      const rect = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return (visible.length ? visible : roots)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || document;
  }

  function labeledTurnContainers(root) {
    return [...root.querySelectorAll("h4, h5")]
      .filter((heading) => {
        const label = normalizeText(heading.textContent).toLowerCase();
        return heading.getAttribute("data-conversation-role") === "assistant"
          || /^(you said|你说|您说|用户说|chatgpt said|chatgpt 说|助手说)/.test(label);
      })
      .map((heading) => heading.parentElement)
      .filter(Boolean);
  }

  function allTurnElements() {
    const result = [];
    const seen = new Set();
    const root = activeConversationRoot();
    const selectors = [
      "[data-testid^='conversation-turn-']",
      "article[data-turn]",
      "[data-turn='user']",
      "[data-turn='assistant']",
      "[data-message-author-role='user']",
      "[data-message-author-role='assistant']",
      "[data-message-id]"
    ];
    const candidates = [...root.querySelectorAll(selectors.join(",")), ...labeledTurnContainers(root)];
    candidates.forEach((element) => {
      const canonical = element.closest("[data-testid^='conversation-turn-']")
        || element.closest("article[data-turn], [data-turn='user'], [data-turn='assistant']")
        || element.closest("[data-message-id]")
        || element.closest("[data-message-author-role]")
        || element;
      if (canonical.closest("#cbw-root, #cbw-native-root") || seen.has(canonical)) return;
      const role = roleFor(canonical);
      if (!['user', 'assistant'].includes(role)) return;
      seen.add(canonical);
      result.push(canonical);
    });
    return result.sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function turnDescriptor(element, index) {
    const role = roleFor(element);
    const content = contentElement(element);
    const cleanCopy = content?.cloneNode(true);
    cleanCopy?.querySelectorAll?.("[data-cbw-native-ui]").forEach((item) => item.remove());
    const text = normalizeText(cleanCopy?.textContent || "");
    const testId = element.getAttribute("data-testid") || "";
    const messageIds = element.querySelector?.("[data-chatgpt-search-message-ids]")?.getAttribute("data-chatgpt-search-message-ids") || "";
    const selectionId = element.querySelector?.("[data-chatgpt-selection-message-id]")?.getAttribute("data-chatgpt-selection-message-id") || "";
    const searchKey = element.querySelector?.("[data-chatgpt-search-unit-key]")?.getAttribute("data-chatgpt-search-unit-key") || "";
    const ordinalText = searchKey.match(/fallback-turn-(\d+):/)?.[1]
      || testId.match(/conversation-turn-(\d+)/)?.[1]
      || "";
    const ordinal = ordinalText === "" ? null : Number(ordinalText);
    const sourceKey = testId
      || (messageIds ? `message:${messageIds}` : "")
      || (selectionId ? `message:${selectionId}` : "")
      || searchKey
      || `${role}:${index}:${hashText(text)}`;
    return { element, content, role, text, hash: hashText(text), sourceKey, searchKey, ordinal, index };
  }

  function collectRounds() {
    const turns = allTurnElements().map(turnDescriptor);
    const rounds = [];
    let pendingUser = null;
    turns.forEach((turn) => {
      if (turn.role === "user") {
        if (pendingUser) rounds.push({ user: pendingUser, assistant: null });
        pendingUser = turn;
        return;
      }
      if (turn.role === "assistant") {
        if (pendingUser) {
          rounds.push({ user: pendingUser, assistant: turn });
          pendingUser = null;
        }
      }
    });
    if (pendingUser) rounds.push({ user: pendingUser, assistant: null });
    return rounds;
  }

  function nativeOlderControl(root = activeConversationRoot()) {
    const pattern = /(load|show).*(older|previous|earlier)|(older|previous|earlier).*messages|加载.*(更早|历史|此前)|显示.*(更早|历史)/i;
    return [...root.querySelectorAll("button, [role='button']")].find((element) => {
      if (element.closest("#cbw-root, #cbw-native-root")) return false;
      const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`;
      return pattern.test(normalizeText(label));
    }) || null;
  }

  function historyBoundary(rounds = collectRounds()) {
    const firstOrdinal = rounds.map((round) => round.user?.ordinal).find(Number.isFinite);
    const control = nativeOlderControl();
    if (control) return { hasEarlier: true, known: true, firstOrdinal: firstOrdinal ?? null, reason: "native-control", control };
    if (Number.isFinite(firstOrdinal)) {
      return { hasEarlier: firstOrdinal > 0, known: true, firstOrdinal, reason: "turn-ordinal", control: null };
    }
    return { hasEarlier: false, known: false, firstOrdinal: null, reason: "unknown", control: null };
  }

  function findConversationScrollContainer() {
    const first = collectRounds()[0]?.user?.content;
    let element = first?.parentElement;
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40) return element;
      element = element.parentElement;
    }
    const root = activeConversationRoot();
    const candidates = [root, ...root.querySelectorAll("[class*='overflow-y-auto'], [class*='overflow-auto'], [role='presentation']")]
      .filter((candidate) => {
        const style = getComputedStyle(candidate);
        return /(auto|scroll)/.test(style.overflowY) && candidate.scrollHeight > candidate.clientHeight + 40;
      });
    return candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      || document.scrollingElement;
  }

  function diagnostics() {
    const root = activeConversationRoot();
    return {
      explicitTurns: document.querySelectorAll("[data-testid^='conversation-turn-'], [data-turn='user'], [data-turn='assistant']").length,
      roleNodes: document.querySelectorAll("[data-message-author-role='user'], [data-message-author-role='assistant']").length,
      mainArticles: document.querySelectorAll("main article").length,
      messageIds: document.querySelectorAll("main [data-message-id]").length,
      labeledTurns: labeledTurnContainers(root).length,
      activeMain: root === document ? null : root.id || "(no id)"
    };
  }

  function titleFor(text) {
    const plain = normalizeText(text)
      .replace(/```[\s\S]*?```/g, "代码问题")
      .replace(/[#>*_`~\[\]()]/g, " ")
      .replace(/https?:\/\/\S+/g, "链接")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) return "新问题";
    return plain.length > 30 ? `${plain.slice(0, 30)}…` : plain;
  }

  function findComposer() {
    return ["#prompt-textarea", "textarea[data-id='root']", "form textarea", "form div[contenteditable='true']"]
      .map((selector) => document.querySelector(selector))
      .find((element) => element && !element.closest("#cbw-root, #cbw-native-root")) || null;
  }

  function isGenerating() {
    return Boolean(document.querySelector("button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']"));
  }

  CBW.adapter = {
    hashText,
    normalizeText,
    activeConversationRoot,
    roleFor,
    contentElement,
    collectRounds,
    historyBoundary,
    nativeOlderControl,
    findConversationScrollContainer,
    diagnostics,
    titleFor,
    findComposer,
    isGenerating
  };
})();
