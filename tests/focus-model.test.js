"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

let sequence = 0;
globalThis.__CBWNative = {
  util: {
    uid: (prefix) => `${prefix}_${++sequence}`,
    now: () => "2026-10-24T00:00:00.000Z"
  },
  adapter: {
    titleFor: (text) => text,
    normalizeText: (text) => text.trim(),
    hashText: (text) => `hash-${text}`,
    isGenerating: () => false
  }
};

const source = fs.readFileSync(path.join(__dirname, "..", "src", "focus-model.js"), "utf8");
vm.runInThisContext(source, { filename: "focus-model.js" });
const model = globalThis.__CBWNative.model;

const createState = () => ({
  version: 4,
  activeNodeId: null,
  attachmentNodeId: null,
  activeFocusId: null,
  displayMode: "all",
  nodes: [],
  focuses: [],
  folds: {}
});
const round = (key) => ({
  user: { sourceKey: `u-${key}`, hash: `hash-${key}`, text: key, ordinal: null },
  assistant: { sourceKey: `a-${key}`, hash: `ah-${key}`, text: `${key}-answer` }
});

const state = createState();
model.reconcileRounds(state, [round("A"), round("B"), round("C")]);
const [nodeA, nodeB, nodeC] = state.nodes;
assert.equal(state.attachmentNodeId, nodeC.id, "initial import advances attachment to the latest node");

model.selectNode(state, nodeA.id);
assert.equal(state.activeNodeId, nodeA.id);
assert.equal(state.attachmentNodeId, nodeC.id, "plain node selection only changes location selection");

model.setAttachment(state, nodeB.id);
const nodeD = model.capturePendingUser(state, "D");
assert.equal(nodeD.parentId, nodeB.id);
assert.equal(state.attachmentNodeId, nodeD.id, "new nodes automatically advance the attachment point");

const focusB = model.createFocus(state, nodeB.id);
const focusD = model.createFocus(state, nodeD.id);
assert.equal(model.createFocus(state, nodeD.id), focusD, "one node reuses its existing focus");
model.selectFocus(state, focusD.id);
assert.deepEqual(model.activeFocusPath(state).map((node) => node.title), ["A", "B", "D"]);
assert.equal(state.displayMode, "focus");

assert.equal(model.renameNode(state, nodeD.id, "D renamed"), true);
assert.equal(model.renameFocus(state, focusD.id, "思路 D"), true);
assert.equal(model.renameNode(state, nodeD.id, "x".repeat(100)), false, "names must be shorter than 100 characters");

model.setAttachment(state, nodeD.id);
const nodeE = model.capturePendingUser(state, "E");
assert.equal(focusD.targetNodeId, nodeE.id, "the active focus advances with the thought currently being extended");
const dUserKey = nodeD.userKey;
const move = model.moveNode(state, nodeD.id, nodeC.id);
assert.equal(move.ok, true);
assert.equal(nodeD.parentId, nodeC.id);
assert.deepEqual(new Set(move.removedFocuses.map((focus) => focus.id)), new Set([focusD.id]));
assert.equal(state.focuses.some((focus) => focus.id === focusB.id), true, "focus outside the moved subtree survives");
assert.equal(state.activeFocusId, null);
assert.equal(state.displayMode, "all");
assert.equal(nodeD.userKey, dUserKey, "moving a subtree preserves native location identity");
assert.equal(state.attachmentNodeId, nodeE.id, "moving a subtree preserves its attachment pointer");
assert.equal(model.moveNode(state, nodeC.id, nodeE.id).ok, false, "cycles are rejected");
model.selectFocus(state, focusB.id);
assert.deepEqual(model.removeFocusAtNode(state, nodeB.id).map((focus) => focus.id), [focusB.id]);
assert.equal(state.activeFocusId, null, "removing the active focus exits focus mode");
assert.equal(state.displayMode, "all");

const historyState = createState();
model.reconcileRounds(historyState, [round("C"), round("D")]);
const originalAttachment = historyState.attachmentNodeId;
const imported = model.importEarlierRounds(historyState, [round("A"), round("B"), round("C"), round("D")]);
assert.equal(imported.added.length, 2);
assert.deepEqual(model.nodePath(historyState, originalAttachment).map((node) => node.title), ["A", "B", "C", "D"]);
assert.equal(historyState.attachmentNodeId, originalAttachment, "history import preserves the attachment point");

console.log("focus-model tests OK");
