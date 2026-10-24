"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const repo = path.resolve(__dirname, "..");
const profile = path.join(repo, ".edge-fixture-test-profile");
const port = 9334;
const fixtures = process.argv.slice(2).map((fixture) => path.resolve(fixture));
const scripts = [
  "src/storage.js", "src/chatgpt-adapter.js", "src/focus-model.js",
  "src/focus-panel.js", "src/folding.js", "src/native-app.js"
];

assert.ok(fs.existsSync(edge), "Microsoft Edge not found");
assert.ok(profile.startsWith(repo + path.sep), "Unsafe Edge profile path");
assert.ok(fixtures.length > 0, "Usage: node tests/fixture-browser.test.js <saved-chatgpt-page.html> [...]");
fixtures.forEach((fixture) => assert.ok(fs.existsSync(fixture), `Missing fixture: ${fixture}`));
if (fs.existsSync(profile)) fs.rmSync(profile, { recursive: true, force: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      (this.events.get(message.method) || []).splice(0).forEach((resolve) => resolve(message.params));
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  waitFor(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
      const handlers = this.events.get(method) || [];
      handlers.push((params) => { clearTimeout(timer); resolve(params); });
      this.events.set(method, handlers);
    });
  }
  close() { this.ws.close(); }
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Edge remote debugger did not start");
}

async function createPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const page = await response.json();
  return new CDP(page.webSocketDebuggerUrl);
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function loadFixture(client, fixture, beforeInjection = "") {
  await client.call("Emulation.setScriptExecutionDisabled", { value: true });
  const loaded = client.waitFor("Page.loadEventFired");
  await client.call("Page.navigate", { url: pathToFileURL(fixture).href });
  await loaded;
  await client.call("Emulation.setScriptExecutionDisabled", { value: false });
  await evaluate(client, `(() => {
    document.querySelectorAll('#cbw-root,#cbw-native-root').forEach((element) => element.remove());
    document.querySelectorAll('.cbw-native-turn-hidden,.cbw-native-fold-hidden,.cbw-native-turn-located').forEach((element) => {
      element.classList.remove('cbw-native-turn-hidden','cbw-native-fold-hidden','cbw-native-turn-located');
    });
    document.querySelectorAll('[data-cbw-native-ui]').forEach((element) => element.remove());
    document.documentElement.dataset.cbwViewMode = 'native';
    localStorage.clear();
    delete globalThis.__CBWNative;
    delete globalThis.__CBWNativeAppLoaded;
  })()`);
  if (beforeInjection) await evaluate(client, beforeInjection);
  for (const script of scripts) {
    await evaluate(client, fs.readFileSync(path.join(repo, script), "utf8"));
  }
  await evaluate(client, `(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(fs.readFileSync(path.join(repo, "native.css"), "utf8"))};
    document.head.appendChild(style);
  })()`);
  await delay(800);
}

async function verifyHistoryLoading(client, fixture) {
  await loadFixture(client, fixture, `(() => {
    const roots = [...document.querySelectorAll('main')].filter((root) => {
      const rect = root.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && root.querySelector('[data-user-message-bubble="true"]');
    }).sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height)-(a.getBoundingClientRect().width*a.getBoundingClientRect().height));
    const root = roots[0];
    const turns = [...root.querySelectorAll('h4,h5')].filter((heading) => /^(你说|ChatGPT 说|you said|chatgpt said)/i.test(heading.textContent.trim())).map((heading) => heading.parentElement);
    const removed = turns.slice(0,2).map((turn) => {
      const marker = document.createComment('history-fixture-marker');
      turn.replaceWith(marker);
      return { turn, marker };
    });
    globalThis.__historyFixtureRestore = () => removed.forEach(({ turn, marker }) => marker.replaceWith(turn));
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = '加载更早消息';
    globalThis.__historyFixtureRestoreCount = 0;
    control.addEventListener('click', () => {
      globalThis.__historyFixtureRestoreCount += 1;
      globalThis.__historyFixtureRestore();
      control.remove();
    }, { once:true });
    root.prepend(control);
  })()`);
  await evaluate(client, `(() => {
    const scroller = globalThis.__CBWNative.adapter.findConversationScrollContainer();
    scroller.scrollTop = Math.min(1000, Math.max(100, scroller.scrollHeight - scroller.clientHeight));
  })()`);
  const before = await evaluate(client, `(() => ({
    graphCount:document.querySelectorAll('#cbw-native-root .cbw-native-node').length,
    available:document.querySelector('#cbw-native-root [data-action="history"]').classList.contains('available'),
    disabled:document.querySelector('#cbw-native-root [data-action="history"]').disabled,
    nativeControl:globalThis.__CBWNative.adapter.nativeOlderControl()?.textContent || null
    ,scrollTop:globalThis.__CBWNative.adapter.findConversationScrollContainer().scrollTop
  }))()`);
  assert.equal(before.graphCount, 1, "simulation must initially expose only the later round");
  assert.equal(before.available, true, "history button must light when turn zero is missing");
  await evaluate(client, `document.querySelector('#cbw-native-root [data-action="history"]').click()`);
  await delay(6000);
  const after = await evaluate(client, `(() => ({
    graphCount:document.querySelectorAll('#cbw-native-root .cbw-native-node').length,
    titles:[...document.querySelectorAll('#cbw-native-root .cbw-native-node-title')].map((item) => item.textContent),
    disabled:document.querySelector('#cbw-native-root [data-action="history"]').disabled,
    available:document.querySelector('#cbw-native-root [data-action="history"]').classList.contains('available')
    ,ordinals:globalThis.__CBWNative.adapter.collectRounds().map((round) => round.user.ordinal)
    ,status:document.querySelector('#cbw-native-root .cbw-native-status').textContent
    ,restoreCount:globalThis.__historyFixtureRestoreCount
    ,nativeControl:globalThis.__CBWNative.adapter.nativeOlderControl()?.textContent || null
  }))()`);
  console.log(JSON.stringify({ fixture: `${path.basename(fixture)} (history simulation)`, before, after }, null, 2));
  assert.equal(after.graphCount, 2, "history loading must prepend the restored earlier round");
  assert.equal(after.disabled, true, "history button must turn gray after reaching turn zero");
  assert.equal(after.available, false);
}

async function verifyVirtualizedLocation(client, fixture) {
  await loadFixture(client, fixture);
  const before = await evaluate(client, `(async () => {
    const rounds = globalThis.__CBWNative.adapter.collectRounds();
    const removed = [rounds[1].user.element, rounds[1].assistant.element].map((turn) => {
      const marker = document.createComment('location-fixture-marker');
      turn.replaceWith(marker);
      return { turn, marker };
    });
    const scroller = globalThis.__CBWNative.adapter.findConversationScrollContainer();
    const originalScrollTo = scroller.scrollTo.bind(scroller);
    let restored = false;
    scroller.scrollTo = (options) => {
      originalScrollTo(options);
      const top = typeof options === 'object' ? options.top : 0;
      if (restored || top <= 0) return;
      restored = true;
      removed.forEach(({ turn, marker }) => marker.replaceWith(turn));
    };
    scroller.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const nodes = [...document.querySelectorAll('#cbw-native-root .cbw-native-node')];
    const targetId = nodes.at(-1).dataset.nodeId;
    const initiallyBound = Boolean(document.querySelector('[data-cbw-node-content-id="' + CSS.escape(targetId) + '"]'));
    nodes.at(-1).click();
    return { targetId, graphCount:nodes.length, initiallyBound };
  })()`);
  assert.equal(before.graphCount, 2);
  assert.equal(before.initiallyBound, false, "target must begin outside the simulated DOM window");
  await delay(1200);
  const after = await evaluate(client, `(() => {
    const target = document.querySelector('[data-cbw-node-content-id="' + CSS.escape(${JSON.stringify(before.targetId)}) + '"]');
    return { bound:Boolean(target), highlighted:Boolean(target?.classList.contains('cbw-native-turn-located')), status:document.querySelector('#cbw-native-root .cbw-native-status').textContent };
  })()`);
  assert.equal(after.bound, true, "node location must wait for a virtualized target to enter the DOM");
  assert.equal(after.highlighted, true, "the recovered target must be highlighted");
  console.log(JSON.stringify({ fixture: `${path.basename(fixture)} (virtualized location)`, before, after }, null, 2));
}

async function verifyFocusControls(client, fixture) {
  await loadFixture(client, fixture);
  const visibilityBefore = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('#cbw-native-root .cbw-native-node')];
    const firstActions = [...rows[0].querySelectorAll('.cbw-native-node-action')];
    const activeAttachment = document.querySelector('#cbw-native-root [data-action="attach"].active');
    const rect = rows[0].getBoundingClientRect();
    return {
      x:rect.left + rect.width / 2, y:rect.top + rect.height / 2,
      inactiveOpacities:firstActions.map((button) => getComputedStyle(button).opacity),
      activeOpacity:getComputedStyle(activeAttachment).opacity
    };
  })()`);
  visibilityBefore.inactiveOpacities.forEach((opacity) => assert.equal(opacity, "0"));
  assert.equal(visibilityBefore.activeOpacity, "1");
  await client.call("Input.dispatchMouseEvent", { type:"mouseMoved", x:visibilityBefore.x, y:visibilityBefore.y });
  await delay(180);
  const visibilityHover = await evaluate(client, `(() => {
    const row = document.querySelector('#cbw-native-root .cbw-native-node');
    return row ? [...row.querySelectorAll('.cbw-native-node-action')].map((button) => getComputedStyle(button).opacity) : [];
  })()`);
  visibilityHover.forEach((opacity) => assert.equal(opacity, "1"));
  await client.call("Input.dispatchMouseEvent", { type:"mouseMoved", x:1000, y:10 });
  const result = await evaluate(client, `(async () => {
    const root = document.querySelector('#cbw-native-root');
    const rows = [...root.querySelectorAll('.cbw-native-node')];
    const firstId = rows[0].dataset.nodeId;
    const lastId = rows.at(-1).dataset.nodeId;
    const initialAttachment = root.querySelector('[data-action="attach"].active')?.dataset.nodeId;
    rows[0].click();
    await new Promise((resolve) => setTimeout(resolve, 320));
    const attachmentAfterLocate = root.querySelector('[data-action="attach"].active')?.dataset.nodeId;
    root.querySelector('[data-action="attach"][data-node-id="' + CSS.escape(firstId) + '"]').click();
    const attachmentAfterSet = root.querySelector('[data-action="attach"].active')?.dataset.nodeId;
    root.querySelector('[data-action="toggle-focus"][data-node-id="' + CSS.escape(firstId) + '"]').click();
    const focusButton = root.querySelector('.cbw-native-focus');
    const focusCreated = Boolean(focusButton);
    focusButton.click();
    await new Promise((resolve) => setTimeout(resolve, 320));
    const hiddenInFocus = document.querySelectorAll('.cbw-native-turn-hidden').length;
    const graphCountInFocus = root.querySelectorAll('.cbw-native-node').length;
    root.querySelector('[data-action="toggle-focus"][data-node-id="' + CSS.escape(firstId) + '"]').click();
    const focusRemoved = !root.querySelector('.cbw-native-focus');
    const hiddenAfterDelete = document.querySelectorAll('.cbw-native-turn-hidden').length;
    const graphCountAfterDelete = root.querySelectorAll('.cbw-native-node').length;
    root.querySelector('[data-action="toggle-focus"][data-node-id="' + CSS.escape(firstId) + '"]').click();

    const rename = (label, value) => {
      label.dispatchEvent(new MouseEvent('click', { bubbles:true, detail:1 }));
      label.dispatchEvent(new MouseEvent('click', { bubbles:true, detail:2 }));
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, detail:2 }));
      const input = root.querySelector('.cbw-native-rename');
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
    };
    rename(root.querySelector('.cbw-native-node[data-node-id="' + CSS.escape(firstId) + '"] .cbw-native-node-title'), '重命名节点');
    rename(root.querySelector('.cbw-native-focus span'), '专注测试');
    return {
      branchActionExists:Boolean(root.querySelector('[data-action="branch"], [data-action="filter"]')),
      initialAttachment, attachmentAfterLocate, attachmentAfterSet, firstId, lastId,
      focusCreated, focusName:root.querySelector('.cbw-native-focus span')?.textContent,
      nodeName:root.querySelector('.cbw-native-node[data-node-id="' + CSS.escape(firstId) + '"] .cbw-native-node-title')?.textContent,
      hiddenInFocus, focusRemoved, hiddenAfterDelete, graphCountInFocus, graphCountAfterDelete,
      nodeActionCounts:[...root.querySelectorAll('.cbw-native-node')].map((row) => row.querySelectorAll('.cbw-native-node-action').length)
    };
  })()`);
  assert.equal(result.branchActionExists, false, "legacy branch controls must be removed");
  assert.equal(result.initialAttachment, result.lastId);
  assert.equal(result.attachmentAfterLocate, result.lastId, "node location must not change attachment");
  assert.equal(result.attachmentAfterSet, result.firstId);
  assert.equal(result.focusCreated, true);
  assert.ok(result.hiddenInFocus > 0, "activating a focus must hide messages outside its root-to-target path");
  assert.equal(result.graphCountInFocus, 1, "the graph must collapse nodes outside the active focus path");
  assert.equal(result.focusRemoved, true, "clicking an active focus star must delete the focus");
  assert.equal(result.hiddenAfterDelete, 0, "deleting the active focus must restore all messages");
  assert.equal(result.graphCountAfterDelete, 2);
  assert.equal(result.nodeName, "重命名节点");
  assert.equal(result.focusName, "专注测试");
  result.nodeActionCounts.forEach((count) => assert.equal(count, 2));
  console.log(JSON.stringify({ fixture: `${path.basename(fixture)} (focus controls)`, visibilityBefore, visibilityHover, result }, null, 2));
}

async function verifyThemeModes(client, fixture) {
  await client.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value: "dark" }]
  });
  await loadFixture(client, fixture);
  const readTheme = () => evaluate(client, `(() => {
    const root = document.querySelector('#cbw-native-root');
    const panel = root.querySelector('.cbw-native-panel');
    const button = root.querySelector('[data-action="theme"]');
    return { mode:root.dataset.cbwTheme, background:getComputedStyle(panel).backgroundColor, icon:button.textContent, title:button.title };
  })()`);
  const automatic = await readTheme();
  assert.equal(automatic.mode, "auto");
  assert.equal(automatic.background, "rgb(33, 33, 33)", "auto mode must follow Edge dark preference");
  await evaluate(client, `document.querySelector('#cbw-native-root [data-action="theme"]').click()`);
  const light = await readTheme();
  assert.equal(light.mode, "light");
  assert.equal(light.background, "rgb(255, 255, 255)");
  await evaluate(client, `document.querySelector('#cbw-native-root [data-action="theme"]').click()`);
  const dark = await readTheme();
  assert.equal(dark.mode, "dark");
  assert.equal(dark.background, "rgb(33, 33, 33)");
  await evaluate(client, `document.querySelector('#cbw-native-root [data-action="theme"]').click()`);
  const restored = await readTheme();
  assert.equal(restored.mode, "auto");
  const persisted = await evaluate(client, `JSON.parse(localStorage.getItem('chatBranchWorkspace:v4:preferences')).themeMode`);
  assert.equal(persisted, "auto");
  await client.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await delay(100);
  const followedChange = await readTheme();
  assert.equal(followedChange.background, "rgb(255, 255, 255)", "auto mode must react to Edge preference changes without reload");
  await client.call("Emulation.setEmulatedMedia", { media: "", features: [] });
  console.log(JSON.stringify({ fixture: `${path.basename(fixture)} (theme modes)`, automatic, light, dark, restored, followedChange, persisted }, null, 2));
}

async function verifyFixture(client, fixture) {
  await loadFixture(client, fixture);
  const summary = await evaluate(client, `(() => {
    const root = globalThis.__CBWNative.adapter.activeConversationRoot();
    const rounds = globalThis.__CBWNative.adapter.collectRounds();
    const boundary = globalThis.__CBWNative.adapter.historyBoundary(rounds);
    const historyButton = document.querySelector('#cbw-native-root [data-action="history"]');
    return {
      mainId: root.id || null,
      mainRect: (() => { const r = root.getBoundingClientRect(); return { width:r.width,height:r.height }; })(),
      roundCount: rounds.length,
      graphCount: document.querySelectorAll('#cbw-native-root .cbw-native-node').length,
      roles: rounds.map((round) => [round.user?.role, round.assistant?.role || null]),
      userRects: rounds.map((round) => { const r=round.user.content.getBoundingClientRect(); return {top:r.top,width:r.width,height:r.height}; }),
      sourceKeys: rounds.map((round) => [round.user.sourceKey, round.assistant?.sourceKey || null])
      ,ordinals: rounds.map((round) => round.user.ordinal)
      ,history: { hasEarlier:boundary.hasEarlier, known:boundary.known, firstOrdinal:boundary.firstOrdinal, buttonDisabled:historyButton.disabled, buttonAvailable:historyButton.classList.contains('available') }
    };
  })()`);
  assert.ok(summary.mainRect.width > 0 && summary.mainRect.height > 0, "must select the visible ChatGPT main");
  assert.ok(summary.roundCount > 0, "must recognize at least one round");
  assert.equal(summary.graphCount, summary.roundCount, "every round must become one graph node");
  summary.roles.forEach((roles) => assert.deepEqual(roles, ["user", "assistant"]));
  summary.userRects.forEach((rect) => assert.ok(rect.width > 0 && rect.height > 0, "user target must have real geometry"));
  assert.equal(summary.history.buttonDisabled, !summary.history.hasEarlier, "history button enabled state must follow the detected boundary");
  assert.equal(summary.history.buttonAvailable, summary.history.hasEarlier, "history button highlight must follow the detected boundary");

  const location = await evaluate(client, `(async () => {
    const nodes = [...document.querySelectorAll('#cbw-native-root .cbw-native-node')];
    const node = nodes.at(-1);
    const nodeId = node.dataset.nodeId;
    const target = document.querySelector('[data-cbw-node-content-id="' + CSS.escape(nodeId) + '"]');
    let scroller = target.parentElement;
    while (scroller && scroller !== document.body) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 20) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) scroller = document.scrollingElement;
    scroller.scrollTop = 0;
    const before = scroller.scrollTop;
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const rect = target.getBoundingClientRect();
    return { before, after:scroller.scrollTop, targetTop:rect.top, targetHeight:rect.height, highlighted:target.classList.contains('cbw-native-turn-located') };
  })()`);
  assert.ok(location.targetHeight > 0, "located target must be a rendered object");
  if (summary.roundCount > 1) assert.ok(location.after > location.before + 50, "clicking a later node must move the real scroll container");
  assert.ok(location.highlighted, "located target must be highlighted");
  console.log(JSON.stringify({ fixture: path.basename(fixture), summary, location }, null, 2));
}

(async () => {
  const browser = spawn(edge, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  try {
    await waitForDebugger();
    const client = await createPage();
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    for (const fixture of fixtures) await verifyFixture(client, fixture);
    const completeFixture = fixtures.find((fixture) => /曲线积分/i.test(path.basename(fixture)));
    if (completeFixture) {
      await verifyFocusControls(client, completeFixture);
      await verifyVirtualizedLocation(client, completeFixture);
      await verifyHistoryLoading(client, completeFixture);
    }
    if (fixtures[0]) await verifyThemeModes(client, fixtures[0]);
    client.close();
  } finally {
    browser.kill();
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), delay(2000)]);
    for (let attempt = 0; attempt < 5 && fs.existsSync(profile); attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true }); }
      catch (error) { if (attempt === 4) throw error; await delay(300); }
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
