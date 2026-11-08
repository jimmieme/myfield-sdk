import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import { createInstance, createInstanceKey, createAuthorizationStorage, ClientError } from "../src/index.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { createMemoryStorageAdapter } from "../src/bucket/store.ts";
import { buildApprovedCallback, decodeAuthRequestFragment } from "./auth-fixture.mjs";

const appId = "flow.example.com", origin = "https://flow.example.com", authBase = "https://auth.example.test/auth/";
const code = value => error => error instanceof ClientError && error.code === value;
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("authorization did not reach the expected step");
}
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(crypto.randomUUID());
    request.onupgradeneeded = () => request.result.createObjectStore("auth");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function browser(t) {
  const previous = globalThis.window, listeners = new Set(), popups = [];
  const location = new URL(origin + "/note");
  const window = {
    location,
    history: { replaceState(_state, _title, url) { location.href = url; } },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
    open(url) {
      const popup = { url, closed: false, focus() {}, close() { this.closed = true; }, location: {} };
      Object.defineProperty(popup.location, "href", { set(value) { popup.url = value; } });
      popups.push(popup); return popup;
    },
  };
  globalThis.window = window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return { window, popups, listeners, send(popup, callbackUrl) {
    for (const listener of [...listeners]) listener({ source: popup, origin: new URL(authBase).origin,
      data: { type: "myfield.auth.callback", callbackUrl } });
  } };
}
async function callback(popup) {
  const wire = decodeAuthRequestFragment(popup.url);
  return (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
}
function service(failHead = () => false) {
  return async (url, init) => {
    if (url.endsWith("instance-challenge")) return Response.json({ ok: true, challengeId: "challenge", challenge: "proof", expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (url.endsWith("instance-session")) return Response.json({ ok: true, ...JSON.parse(init.body), capabilities: ["read", "write"],
      credential: { carrier: "bearer", token: "token", expiresAt: new Date(Date.now() + 7200000).toISOString() } });
    if (failHead()) return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
    return Response.json({ versionId: null, headVersionMeta: null });
  };
}

test("Remote redirect restores the original identity and pending request without saving or binding a grant", async t => {
  const ui = browser(t), db = await database(), store = createAuthorizationStorage({ database: db, store: "auth" });
  const key = await createInstanceKey();
  const previousIndexedDB = globalThis.indexedDB;
  globalThis.indexedDB = { open() { assert.fail("Remote redirect touched the object database"); } };
  t.after(() => { if (previousIndexedDB === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previousIndexedDB; });
  const settings = { storage: "memory", authStorage: { database: db, store: "auth" }, authBase, fetch: async () => assert.fail("unexpected HTTP") };
  const first = createInstance(appId, { ...settings, instanceKey: key });
  t.after(() => { first.dispose(); db.close(); });
  assert.equal(await first.remote.auth.handleCallback(), null);
  await first.remote.auth.authorize({ mode: "redirect" });
  assert.equal(ui.popups.length, 0);
  const wire = decodeAuthRequestFragment(ui.window.location.href);
  assert.equal(wire.mf_instance_id, key.instanceId);
  assert.ok((await store.keys("")).some(value => value.includes(":pending-auth:")));
  ui.window.location.href = (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
  first.dispose();
  const restored = createInstance(appId, settings); t.after(() => restored.dispose());
  assert.equal(restored.instanceKey, null);
  const grant = await restored.remote.auth.handleCallback();
  assert.equal(grant.instanceId, key.instanceId); assert.equal(grant.payloadKey.extractable, false);
  assert.equal(restored.instanceKey.instanceId, key.instanceId);
  assert.equal(restored.remote.authorization, null);
  assert.equal(await restored.remote.auth.handleCallback(), null);
  assert.equal(ui.window.location.href, origin + "/note");
  const keys = await store.keys("");
  assert.ok(keys.every(value => !value.includes(":pending-auth:") && !value.includes(":callback-pointer:") && !value.includes(":context:")));
});

test("Remote callback rejects missing, expired and mismatched pending requests without opening authorization", async t => {
  const ui = browser(t), db = await database(), store = createAuthorizationStorage({ database: db, store: "auth" });
  const instance = createInstance(appId, { storage: "memory", instanceKey: await createInstanceKey(), authBase, authStorage: { database: db, store: "auth" } });
  t.after(() => { instance.dispose(); db.close(); });
  ui.window.location.href = origin + "/note?mf_request_id=missing&mf_result=approved&state=missing";
  await assert.rejects(instance.remote.auth.handleCallback(), code("INVALID_AUTHORIZATION"));
  ui.window.location.href = origin + "/note";
  await instance.remote.auth.authorize({ mode: "redirect" });
  const wire = decodeAuthRequestFragment(ui.window.location.href);
  const approved = (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
  const invalid = new URL(approved); invalid.searchParams.set("state", "wrong"); ui.window.location.href = invalid.href;
  await assert.rejects(instance.remote.auth.handleCallback(), code("INVALID_AUTHORIZATION"));
  const pointerKey = (await store.keys("")).find(value => value.includes(":callback-pointer:"));
  const pointer = await store.get(pointerKey); pointer.createdAt = new Date(Date.now() - 3600000).toISOString(); await store.set(pointerKey, pointer);
  ui.window.location.href = approved;
  await assert.rejects(instance.remote.auth.handleCallback(), code("INVALID_AUTHORIZATION"));
  assert.ok((await store.keys("")).every(value => !value.includes(":pending-auth:") && !value.includes(":callback-pointer:")));
  assert.equal(ui.popups.length, 0); assert.equal(instance.remote.authorization, null);
});

test("Remote recovery accepts old IndexedDB pending records and does not replace the active identity", async t => {
  const ui = browser(t), db = await database(), store = createAuthorizationStorage({ database: db, store: "auth" });
  const instance = createInstance(appId, { storage: "memory", instanceKey: await createInstanceKey(), authBase, authStorage: { database: db, store: "auth" } });
  t.after(() => { instance.dispose(); db.close(); });
  await instance.remote.auth.authorize({ mode: "redirect" });
  const wire = decodeAuthRequestFragment(ui.window.location.href);
  const pointerKey = (await store.keys("")).find(value => value.includes(":callback-pointer:"));
  const pointer = await store.get(pointerKey), prefix = `instance-scope:${appId}:`;
  const pending = await store.get(prefix + pointer.pendingKey); delete pending.redirectUri;
  await store.set(prefix + pointer.pendingKey, pending);
  ui.window.location.href = (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
  assert.equal((await instance.remote.auth.handleCallback()).instanceId, instance.instanceKey.instanceId);
  assert.ok((await store.keys("")).every(value => !value.includes(":pending-auth:") && !value.includes(":callback-pointer:")));
});

test("new popup replaces Local authorization, settles both connect callers and ignores the old callback", async t => {
  const ui = browser(t), db = await database(), store = createAuthorizationStorage({ database: db, store: "auth" });
  const instance = createInstance(appId, { storage: "memory", authBase, authStorage: { database: db, store: "auth" }, fetch: service() });
  t.after(() => { instance.dispose(); db.close(); });
  const old = assert.rejects(instance.connect({ autoSync: false }), code("AUTHORIZATION_CANCELLED"));
  const joined = instance.bucket.connect({ autoSync: false });
  await until(() => ui.popups[0]?.url.includes("authRequest"));
  const first = ui.popups[0], oldUrl = await callback(first);
  const next = instance.remote.auth.authorize({ mode: "popup" });
  await old; assert.equal(await joined, "disconnected"); assert.equal(first.closed, true);
  const second = ui.popups[1]; assert.notEqual(second, first);
  ui.send(first, oldUrl);
  ui.send(second, await callback(second));
  const grant = await next;
  assert.equal(grant.instanceId, instance.instanceKey.instanceId); assert.equal(instance.remote.authorization, null);
  await until(() => ui.listeners.size === 0);
  assert.ok((await store.keys("")).every(value => !value.includes(":context:")));
});

test("popup authorization stays saved when head validation fails and resume recovers without another popup", async t => {
  const ui = browser(t), db = await database(), store = createAuthorizationStorage({ database: db, store: "auth" });
  let unavailable = true;
  const instance = createInstance(appId, { storage: "memory", authBase, authStorage: { database: db, store: "auth" }, fetch: service(() => unavailable) });
  t.after(() => { instance.dispose(); db.close(); });
  const connecting = assert.rejects(instance.connect({ autoSync: false }), code("INSTANCE_ERROR"));
  await until(() => ui.popups[0]?.url.includes("authRequest"));
  ui.send(ui.popups[0], await callback(ui.popups[0]));
  await connecting;
  assert.equal(instance.bucket.state, "disconnected"); assert.equal(instance.remote.authorization, null);
  assert.ok((await store.keys("")).some(value => value.includes(":context:")));
  unavailable = false;
  assert.equal(await instance.resume(), "connected");
  assert.ok(instance.remote.authorization); assert.equal(ui.popups.length, 1);
});

test("cancelling while a callback is being decrypted cannot save an authorization", async t => {
  const storage = createMemoryStorageAdapter(); let url;
  const client = createInstanceAuthClient({ appId, storage, authPageUrl: authBase, origin, redirectUri: origin + "/note", openAuthUrl: value => { url = value; } });
  await client.authorize({ bucketId: appId });
  const callbackUrl = (await buildApprovedCallback(decodeAuthRequestFragment(url), origin + "/note", { bucketId: appId })).callbackUrl;
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const original = crypto.subtle.decrypt.bind(crypto.subtle); let first = true;
  t.mock.method(crypto.subtle, "decrypt", async (...args) => { if (first) { first = false; entered(); await held; } return original(...args); });
  const abort = new AbortController();
  const completed = assert.rejects(client.handleCallback(callbackUrl, { signal: abort.signal }), error => error === abort.signal.reason);
  await waiting;
  abort.abort(new ClientError("AUTHORIZATION_CANCELLED", "Replaced"));
  await client.cancelAuthorization(decodeAuthRequestFragment(url).mf_request_id);
  release(); await completed;
  assert.ok((await storage.keys("")).every(value => !value.includes(":context:")));
});


test("Local same-tab pending survives disposal during navigation and resumes on return", async t => {
  const ui = browser(t), db = await database();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "iPhone" } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete globalThis.navigator; });
  const settings = { storage: "memory", authBase, authStorage: { database: db, store: "auth" }, fetch: service() };
  const first = createInstance(appId, settings);
  const stopped = assert.rejects(first.connect({ autoSync: false }), code("INSTANCE_DISPOSED"));
  await until(() => ui.window.location.href.includes("authRequest"));
  const wire = decodeAuthRequestFragment(ui.window.location.href), instanceId = first.instanceKey.instanceId;
  first.dispose(); await stopped;
  ui.window.location.href = (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
  const restored = createInstance(appId, settings); t.after(() => { restored.dispose(); db.close(); });
  assert.equal(await restored.resume(), "connected");
  assert.equal(restored.instanceKey.instanceId, instanceId); assert.equal(ui.popups.length, 0);
});

test("replacing Remote popups preserves other Instances and existing bindings", async t => {
  const ui = browser(t);
  const one = createInstance(appId, { instanceKey: await createInstanceKey(), authBase });
  const two = createInstance(appId, { instanceKey: await createInstanceKey(), authBase });
  t.after(() => { one.dispose(); two.dispose(); });
  const old = assert.rejects(one.remote.auth.authorize(), code("AUTHORIZATION_CANCELLED"));
  const independent = two.remote.auth.authorize();
  const next = one.remote.auth.authorize();
  await old;
  assert.equal(ui.popups[0].closed, true); assert.equal(ui.popups[1].closed, false);
  ui.send(ui.popups[2], await callback(ui.popups[2]));
  const grant = await next;
  one.remote.bind(grant); const binding = one.remote.authorization;
  ui.send(ui.popups[1], await callback(ui.popups[1]));
  assert.equal((await independent).instanceId, two.instanceKey.instanceId);
  const cancel = new AbortController(), cancelled = one.remote.auth.authorize({ signal: cancel.signal });
  const failed = assert.rejects(cancelled, error => error.name === "AbortError");
  cancel.abort(); await failed;
  assert.equal(one.remote.authorization, binding); assert.equal(ui.listeners.size, 0);
});

test("a stale redirect callback cannot cancel a newer popup", async t => {
  const ui = browser(t), db = await database();
  const instance = createInstance(appId, { storage: "memory", instanceKey: await createInstanceKey(), authBase, authStorage: { database: db, store: "auth" } });
  t.after(() => { instance.dispose(); db.close(); });
  await instance.remote.auth.authorize({ mode: "redirect" });
  const wire = decodeAuthRequestFragment(ui.window.location.href);
  const oldUrl = (await buildApprovedCallback(wire, origin + "/note", { bucketId: appId })).callbackUrl;
  ui.window.location.href = origin + "/note";
  const current = instance.remote.auth.authorize();
  ui.window.location.href = oldUrl;
  await assert.rejects(instance.remote.auth.handleCallback(), code("INVALID_AUTHORIZATION"));
  assert.equal(ui.popups[0].closed, false);
  ui.send(ui.popups[0], await callback(ui.popups[0]));
  assert.equal((await current).instanceId, instance.instanceKey.instanceId);
});

test("same-tab authorization rejects memory-only auth storage before navigating", async t => {
  const ui = browser(t);
  const instance = createInstance(appId, { storage: "memory", instanceKey: await createInstanceKey(), authBase });
  t.after(() => instance.dispose());
  await assert.rejects(instance.remote.auth.authorize({ mode: "redirect" }), code("AUTH_STORAGE_REQUIRED"));
  assert.equal(ui.window.location.href, origin + "/note"); assert.equal(ui.popups.length, 0);
});

test("a new redirect overwrites the same resource and identity pending slot", async t => {
  const ui = browser(t), db = await database(), key = await createInstanceKey();
  const settings = { storage: "memory", instanceKey: key, authBase, authStorage: { database: db, store: "auth" } };
  const one = createInstance(appId, settings), two = createInstance(appId, settings);
  const store = createAuthorizationStorage({ database: db, store: "auth" });
  t.after(() => { one.dispose(); two.dispose(); db.close(); });
  await one.remote.auth.authorize({ mode: "redirect" }); const first = decodeAuthRequestFragment(ui.window.location.href);
  ui.window.location.href = origin + "/note";
  await two.remote.auth.authorize({ mode: "redirect" }); const second = decodeAuthRequestFragment(ui.window.location.href);
  assert.notEqual(first.mf_request_id, second.mf_request_id);
  const pendingKeys = (await store.keys("")).filter(value => value.includes(":pending-auth:"));
  assert.equal(pendingKeys.length, 1);
  assert.ok(pendingKeys[0].endsWith(key.instanceId));
  assert.equal((await store.keys("")).filter(value => value.includes(":callback-pointer:")).length, 1);
  const current = await store.get(pendingKeys[0]);
  assert.equal(current.requestId, second.mf_request_id);
  ui.window.location.href = (await buildApprovedCallback(first, origin + "/note", { bucketId: appId })).callbackUrl;
  await assert.rejects(one.remote.auth.handleCallback(), code("INVALID_AUTHORIZATION"));
  assert.deepEqual(await store.get(pendingKeys[0]), current);
  ui.window.location.href = (await buildApprovedCallback(second, origin + "/note", { bucketId: appId })).callbackUrl;
  assert.equal((await two.remote.auth.handleCallback()).instanceId, key.instanceId);
});


test("overwriting pending during callback validation rejects the old result without deleting the new request", async t => {
  const storage = createMemoryStorageAdapter(); let url;
  const client = createInstanceAuthClient({ appId, storage, authPageUrl: authBase, origin, redirectUri: origin + "/note", openAuthUrl: value => { url = value; } });
  await client.authorize({ bucketId: appId });
  const callbackUrl = (await buildApprovedCallback(decodeAuthRequestFragment(url), origin + "/note", { bucketId: appId })).callbackUrl;
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let first = true;
  t.mock.method(crypto.subtle, "decrypt", async (...args) => { if (first) { first = false; entered(); await held; } return decrypt(...args); });
  const rejected = assert.rejects(client.handleCallback(callbackUrl), code("AUTHORIZATION_CANCELLED"));
  await waiting;
  const next = await client.prepareAuthorization({ bucketId: appId });
  release(); await rejected;
  const pendingKey = (await storage.keys("")).find(value => value.includes(":pending-auth:"));
  assert.equal((await storage.get(pendingKey)).requestId, next.requestId);
  assert.ok((await storage.keys("")).every(value => !value.includes(":context:")));
});
