"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key)
};
globalThis.location = { pathname: "/c/migration" };
globalThis.__CBWNative = {};

const legacy = {
  version: 3,
  scope: "/c/migration",
  activeRefId: "branch",
  activeNodeId: "b",
  filterMode: "path",
  panelCollapsed: false,
  nodes: [
    { id: "a", parentId: null, title: "A", order: 0, createdAt: "" },
    { id: "b", parentId: "a", title: "B", order: 1, createdAt: "" }
  ],
  refs: [
    { id: "main", name: "main", tipNodeId: "a", createdAt: "" },
    { id: "branch", name: "branch-1", tipNodeId: "b", createdAt: "" },
    { id: "empty", name: "branch-2", tipNodeId: null, createdAt: "" }
  ],
  folds: {}
};
values.set("chatBranchWorkspace:v3:conversation:/c/migration", JSON.stringify(legacy));
values.set("chatBranchWorkspace:v3:preferences", JSON.stringify({ themeMode: "dark" }));

const source = fs.readFileSync(path.join(__dirname, "..", "src", "storage.js"), "utf8");
vm.runInThisContext(source, { filename: "storage.js" });
const storage = globalThis.__CBWNative.storage;
const migrated = storage.load("/c/migration");

assert.equal(migrated.version, 4);
assert.deepEqual(migrated.focuses.map((focus) => [focus.name, focus.targetNodeId]), [["main", "a"], ["branch-1", "b"]]);
assert.equal(migrated.activeFocusId, "focus_branch");
assert.equal(migrated.displayMode, "focus");
assert.equal(migrated.attachmentNodeId, "b");
assert.ok(values.has("chatBranchWorkspace:v4:conversation:/c/migration"), "migration writes a v4 copy");
assert.equal(storage.loadPreferences().themeMode, "dark", "v4 reads the previous global theme preference");

console.log("storage-v4 tests OK");
