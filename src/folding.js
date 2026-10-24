(() => {
  "use strict";

  const CBW = globalThis.__CBWNative ||= {};
  const hiddenReasons = new WeakMap();

  function setHidden(element, reason, hidden) {
    if (!element) return;
    let reasons = hiddenReasons.get(element);
    if (!reasons) {
      reasons = new Set();
      hiddenReasons.set(element, reasons);
    }
    if (hidden) reasons.add(reason);
    else reasons.delete(reason);
    element.classList.toggle("cbw-native-fold-hidden", reasons.size > 0);
  }

  function lineCountForElements(elements) {
    return Math.max(1, elements.reduce((count, element) => {
      const text = (element.textContent || "").replace(/\r\n?/g, "\n");
      return count + Math.max(1, text.split("\n").length);
    }, 0));
  }

  function foldState(state, key) {
    state.folds[key] ||= { collapsed: false, note: "" };
    return state.folds[key];
  }

  function makeNote(key, fold, onChange) {
    const shell = document.createElement("div");
    shell.className = `cbw-native-fold-note${fold.collapsed ? " visible" : ""}`;
    shell.dataset.cbwNativeUi = "true";
    shell.dataset.cbwFoldOwner = key;
    const preview = document.createElement("span");
    preview.textContent = "已折叠";
    const note = document.createElement("textarea");
    note.rows = 1;
    note.placeholder = "添加注释…";
    note.value = fold.note || "";
    note.setAttribute("aria-label", "折叠内容注释");
    note.addEventListener("input", () => {
      fold.note = note.value;
      onChange();
      note.style.height = "auto";
      note.style.height = `${Math.min(note.scrollHeight, 120)}px`;
    });
    shell.append(preview, note);
    return shell;
  }

  function decorateCodeBlocks(content, nodeId, state, onChange) {
    [...content.querySelectorAll("pre")].forEach((pre, index) => {
      if (pre.dataset.cbwFoldReady) return;
      pre.dataset.cbwFoldReady = "true";
      let block = pre;
      const parent = pre.parentElement;
      if (parent && parent !== content && parent.querySelectorAll("pre").length === 1 &&
          (parent.querySelector("button") || /code|contain/i.test(parent.className || ""))) block = parent;

      const codeText = pre.querySelector("code")?.textContent || pre.textContent || "";
      const count = Math.max(1, codeText.replace(/\n$/, "").split(/\r?\n/).length);
      const key = `${nodeId}:code:${index}:${CBW.adapter.hashText(codeText)}`;
      const fold = foldState(state, key);
      const control = document.createElement("div");
      control.className = "cbw-native-code-control";
      control.dataset.cbwNativeUi = "true";
      control.dataset.cbwFoldOwner = key;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cbw-native-fold-toggle${fold.note.trim() ? " annotated" : ""}`;
      const label = document.createElement("span");
      label.textContent = `代码块 · ${count} 行`;
      const updateButton = () => {
        button.textContent = fold.collapsed ? "▸" : "▾";
        button.title = `${fold.collapsed ? "展开" : "折叠"}代码块 · ${count} 行`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-expanded", String(!fold.collapsed));
        button.dataset.lines = String(count);
        button.classList.toggle("annotated", Boolean(fold.note.trim()));
      };
      const note = makeNote(key, fold, () => { updateButton(); onChange(); });
      const apply = () => {
        setHidden(block, key, fold.collapsed);
        note.classList.toggle("visible", fold.collapsed);
        updateButton();
      };
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fold.collapsed = !fold.collapsed;
        apply();
        onChange();
        if (fold.collapsed) note.querySelector("textarea")?.focus();
      });
      control.append(button, label);
      block.before(control, note);
      apply();
    });
  }

  function decorateHeadings(content, nodeId, state, onChange) {
    const headings = [...content.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    headings.forEach((heading, index) => {
      if (heading.dataset.cbwFoldReady) return;
      heading.dataset.cbwFoldReady = "true";
      const level = Number(heading.tagName.slice(1));
      const headingText = (heading.textContent || "").trim();
      const key = `${nodeId}:heading:${index}:${CBW.adapter.hashText(headingText)}`;
      const fold = foldState(state, key);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.cbwNativeUi = "true";
      button.className = `cbw-native-heading-toggle${fold.note.trim() ? " annotated" : ""}`;
      const note = makeNote(key, fold, () => { updateButton(); onChange(); });
      heading.after(note);

      const members = () => {
        const items = [];
        let sibling = note.nextElementSibling;
        while (sibling) {
          if (/^H[1-6]$/.test(sibling.tagName) && Number(sibling.tagName.slice(1)) <= level) break;
          items.push(sibling);
          sibling = sibling.nextElementSibling;
        }
        return items;
      };
      const count = lineCountForElements(members().filter((item) => !item.hasAttribute("data-cbw-native-ui")));
      const updateButton = () => {
        button.textContent = fold.collapsed ? "▸" : "▾";
        button.title = `${fold.collapsed ? "展开" : "折叠"}“${headingText || "章节"}” · ${count} 行`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-expanded", String(!fold.collapsed));
        button.dataset.lines = String(count);
        button.classList.toggle("annotated", Boolean(fold.note.trim()));
      };
      const apply = () => {
        members().forEach((element) => setHidden(element, key, fold.collapsed));
        note.classList.toggle("visible", fold.collapsed);
        updateButton();
      };
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fold.collapsed = !fold.collapsed;
        apply();
        onChange();
        if (fold.collapsed) note.querySelector("textarea")?.focus();
      });
      heading.appendChild(button);
      apply();
    });
  }

  function enhance(state, bindings, onChange) {
    bindings.forEach((round, nodeId) => {
      const content = round.assistant?.content;
      if (!content || !content.isConnected) return;
      decorateCodeBlocks(content, nodeId, state, onChange);
      decorateHeadings(content, nodeId, state, onChange);
    });
  }

  CBW.folding = { enhance };
})();
