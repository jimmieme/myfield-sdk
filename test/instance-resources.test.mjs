import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { createAuthorizationClient, createAuthorizationStorage, createInstance, createInstanceKey, ClientError } from "../src/index.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { decodeAuthRequestFragment, buildApprovedCallback } from "./auth-fixture.mjs";

const failure = code => error => error instanceof ClientError && error.code === code;
const appId = "resources.example.com";

async function bind(instance) {
  const original = globalThis.window;
  globalThis.window = { location: new URL("https://resources.example.com/") };
  try {
    const client = createAuthorizationClient({ appId, instanceKey: instance.instanceKey });
    const request = client.createRequest();
    const { callbackUrl } = await buildApprovedCallback(decodeAuthRequestFragment(request.url), request.redirectUri, { bucketId: appId });
    const grant = await client.handleCallback(callbackUrl, request);
    instance.remote.bind(grant);
    return grant;
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
}

test("resource handles and deprecated ready do no I/O; the first data operation reports storage failures", async () => {
  const original = globalThis.indexedDB;
  let opens = 0, requests = 0;
  const problem = new Error("storage denied");
  globalThis.indexedDB = { open() { opens++; throw problem; } };
  const instance = createInstance(appId, { fetch: async () => { requests++; throw new Error("unexpected network"); } });
  try {
    const bucket = instance.bucket, remote = instance.remote;
    assert.equal(bucket, instance.bucket); assert.equal(bucket, instance.createBucket());
    assert.equal(remote, instance.remote); assert.equal(remote.bucket, remote.bucket); assert.equal(remote.auth, remote.auth);
    assert.equal(instance.instanceKey, null);
    assert.equal(await bucket.ready(), undefined);
    assert.equal(await bucket.ready(), undefined);
    assert.equal(opens, 0); assert.equal(requests, 0);
    await assert.rejects(bucket.get("note"), error => error === problem);
    assert.ok(opens > 0); assert.equal(requests, 0);
  } finally { instance.dispose(); if (original === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = original; }
});

test("first local writes initialize storage and survive reload without ready or authorization", async () => {
  const original = globalThis.indexedDB, originalRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
  const namespace = crypto.randomUUID();
  const settings = { namespace, fetch: async () => { throw new Error("unexpected network"); } };
  const first = createInstance(appId, settings);
  try {
    await first.bucket.put("note", { text: "offline" }); first.dispose();
    const reopened = createInstance(appId, settings);
    try {
      assert.deepEqual(await reopened.bucket.get("note"), { text: "offline" });
      assert.equal(reopened.instanceKey, null);
    } finally { reopened.dispose(); }
  } finally { first.dispose(); globalThis.indexedDB = original; globalThis.IDBKeyRange = originalRange; }
});

test("unified remote auth and bucket share an explicit identity and fetch without local persistence", async () => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error("remote opened a local database"); } };
  const calls = [];
  const instanceKey = await createInstanceKey();
  const instance = createInstance(appId, { instanceKey, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("instance-challenge")) return Response.json({ ok: true, challengeId: "challenge", challenge: "proof", expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (url.endsWith("instance-session")) {
      const body = JSON.parse(init.body);
      assert.equal(body.instanceId, instanceKey.instanceId);
      return Response.json({ ok: true, ...body, capabilities: ["read", "write"], credential: { carrier: "bearer", token: "remote-token", expiresAt: new Date(Date.now() + 7200_000).toISOString() } });
    }
    if (init.method === "POST") return Response.json({ ok: true });
    return Response.json({ versionId: null, headVersionMeta: null });
  } });
  try {
    const remote = instance.remote, grant = await bind(instance);
    assert.equal(remote.apiBase, grant.apiBase); assert.equal(instance.instanceKey, instanceKey);
    assert.equal(await remote.bucket.getCurrent("opaque"), null);
    const version = { meta: { objectId: "opaque", versionId: "version", parentVersionIds: [] }, payload: new Uint8Array([42]) };
    assert.deepEqual(await remote.bucket.commit({ ...version, expectedHeadVersionId: null }), { ok: true });
    assert.deepEqual(new Uint8Array(calls.at(-1).init.body), version.payload);
    assert.equal(calls.length, 4);
    assert.equal(new Headers(calls[2].init.headers).get("authorization"), "Bearer remote-token");
    assert.ok(calls.every(call => call.url.startsWith(grant.apiBase)));
  } finally { instance.dispose(); globalThis.indexedDB = original; }
});

test("remote requires explicit identity/configuration and never falls back to production", async () => {
  let requests = 0;
  const instance = createInstance(appId, { fetch: async () => { requests++; throw new Error("unexpected network"); } });
  try {
    await assert.rejects(instance.remote.auth.createSession({ mfid: "owner", resourceId: "resource" }), failure("INSTANCE_KEY_REQUIRED"));
    await assert.rejects(instance.remote.bucket.getCurrent("note"), failure("REMOTE_NOT_CONFIGURED"));
    assert.equal(instance.instanceKey, null); assert.equal(requests, 0);
  } finally { instance.dispose(); }
});

test("rebinding invalidates late sessions without retargeting their credentials", async () => {
  let release, started, grant;
  const waiting = new Promise(resolve => { started = resolve; });
  const calls = [];
  const instance = createInstance(appId, { instanceKey: await createInstanceKey(), fetch: async (url, init) => {
    calls.push(url);
    if (url.endsWith("instance-challenge")) return Response.json({ ok: true, challengeId: "challenge", challenge: "proof", expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (url.endsWith("instance-session")) {
      started();
      await new Promise(resolve => { release = resolve; });
      return Response.json({ ok: true, ...JSON.parse(init.body), capabilities: ["read"], credential: { carrier: "bearer", token: "old-secret", expiresAt: new Date(Date.now() + 7200_000).toISOString() } });
    }
    assert.fail("stale bucket request sent");
  } });
  try {
    grant = await bind(instance);
    const request = instance.remote.bucket.getCurrent("note");
    await waiting;
    instance.remote.bind({ ...grant, apiBase: "https://other.example.test" });
    release();
    await assert.rejects(request, failure("AUTHORIZATION_CHANGED"));
    assert.ok(calls.every(url => url.startsWith(grant.apiBase)));
    assert.equal(instance.remote.apiBase, "https://other.example.test");
    assert.throws(() => instance.remote.bind({ ...grant, instanceId: "other" }), failure("IDENTITY_MISMATCH"));
    assert.equal(instance.remote.apiBase, "https://other.example.test");
    assert.throws(() => { instance.remote.authorization = grant; }, TypeError);
    assert.throws(() => { instance.remote.apiBase = grant.apiBase; }, TypeError);
    assert.ok(Object.isFrozen(instance.remote.authorization));
    assert.ok(Object.isFrozen(instance.remote.authorization.capabilities));
    instance.remote.unbind();
    assert.equal(instance.remote.authorization, null);
    assert.equal(instance.remote.apiBase, undefined);
    await assert.rejects(instance.remote.bucket.getCurrent("note"), failure("REMOTE_NOT_CONFIGURED"));
  } finally { instance.dispose(); }
});

test("instance disposal aborts remote requests and makes captured handles unusable", async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const instance = createInstance(appId, { instanceKey: await createInstanceKey(), fetch: async (_url, init) => {
    started(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  await bind(instance);
  const remote = instance.remote, bucket = instance.bucket;
  const request = remote.bucket.getCurrent("note");
  await entered; instance.dispose();
  await assert.rejects(request, error => error.name === "AbortError");
  await assert.rejects(remote.bucket.getCurrent("note"), failure("INSTANCE_DISPOSED"));
  assert.equal(await bucket.ready(), undefined);
  await assert.rejects(bucket.get("note"), failure("INSTANCE_DISPOSED"));
});


test("saved authorization without an API URL fails before session requests, with no inferred service", async () => {
  const database = await new Promise((resolve, reject) => {
    const req = indexedDB.open(crypto.randomUUID()); req.onupgradeneeded = () => req.result.createObjectStore("auth");
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  const store = createAuthorizationStorage({ database, store: "auth" });
  const prefix = `instance-scope:${appId}:`;
  const storage = { get: key => store.get(prefix + key), set: (key, value) => store.set(prefix + key, value),
    add: (key, value) => store.add(prefix + key, value), remove: key => store.remove(prefix + key),
    keys: async key => (await store.keys(prefix + key)).map(value => value.slice(prefix.length)) };
  let url, requests = 0;
  const auth = createInstanceAuthClient({ appId, storage, authPageUrl: "https://auth.example.test/auth/",
    origin: "https://resources.example.com", redirectUri: "https://resources.example.com/", openAuthUrl: value => { url = value; } });
  await auth.authorize({ bucketId: appId });
  const { callbackUrl } = await buildApprovedCallback(decodeAuthRequestFragment(url), "https://resources.example.com/", { bucketId: appId });
  await auth.handleCallback(callbackUrl);
  const contextKey = (await storage.keys("")).find(key => key.includes(":context:"));
  const context = await storage.get(contextKey); delete context.resourceApiUrl;
  await storage.set(contextKey, context);
  const instance = createInstance(appId, { storage: "memory", authStorage: { database, store: "auth" },
    fetch: async () => { requests++; throw new Error("unexpected service"); } });
  try {
    await assert.rejects(instance.getSession(), failure("INVALID_RESPONSE"));
    assert.equal(requests, 0); assert.equal(instance.remote.apiBase, undefined);
    assert.ok(instance.instanceKey);
  } finally { instance.dispose(); database.close(); }
});


test("remote sessions coalesce, refresh before expiry and retain authorization after failures", async () => {
  const originalNow = Date.now;
  let clock = originalNow(), sessions = 0, challenges = 0, requests = 0, failSession = true, unauthorized = false;
  Date.now = () => clock;
  const instance = createInstance(appId, { instanceKey: await createInstanceKey(), fetch: async (url, init) => {
    if (url.endsWith("instance-challenge")) {
      challenges++;
      return Response.json({ ok: true, challengeId: "challenge", challenge: "proof", expiresAt: new Date(clock + 60000).toISOString() });
    }
    if (url.endsWith("instance-session")) {
      sessions++;
      if (failSession) return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      return Response.json({ ok: true, ...JSON.parse(init.body), capabilities: ["read"], credential: {
        carrier: "bearer", token: `token-${sessions}`, expiresAt: new Date(clock + 120000).toISOString(),
      } });
    }
    requests++;
    if (unauthorized) return Response.json({ code: "NOT_AUTHORIZED" }, { status: 401 });
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer token-${sessions}`);
    return Response.json({ versionId: null, headVersionMeta: null });
  } });
  try {
    const grant = await bind(instance), remote = instance.remote;
    const first = await Promise.allSettled([remote.bucket.getCurrent("one"), remote.bucket.getCurrent("two")]);
    assert.ok(first.every(result => result.status === "rejected" && result.reason.status === 503));
    assert.equal(sessions, 1); assert.equal(requests, 0);
    assert.equal(remote.authorization.mfid, grant.mfid);
    failSession = false;
    await Promise.all([remote.bucket.getCurrent("one"), remote.bucket.getCurrent("two")]);
    assert.equal(sessions, 2); assert.equal(requests, 2);
    clock += 100000;
    await Promise.all([remote.bucket.getCurrent("one"), remote.bucket.getCurrent("two")]);
    assert.equal(sessions, 3); assert.equal(challenges, 3);
    unauthorized = true;
    await assert.rejects(remote.bucket.getCurrent("one"), error => error.status === 401);
    assert.equal(sessions, 3); assert.equal(requests, 5);
    assert.equal(remote.authorization.mfid, grant.mfid);
    remote.unbind(); remote.bind(grant);
    unauthorized = false;
    await remote.bucket.getCurrent("one");
    assert.equal(sessions, 4);
    await assert.rejects(instance.getSession(), failure("REMOTE_BOUND"));
  } finally { instance.dispose(); Date.now = originalNow; }
});


test("resume without saved access does not reserve or replace externally bound Remote", async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(crypto.randomUUID());
    request.onupgradeneeded = () => request.result.createObjectStore("auth");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const previousWindow = globalThis.window;
  globalThis.window = { location: new URL("https://resources.example.com/"), addEventListener() {}, removeEventListener() {} };
  const instance = createInstance(appId, { instanceKey: await createInstanceKey(), storage: "memory", authStorage: { database, store: "auth" },
    fetch: async () => assert.fail("unexpected network") });
  try {
    const grant = await bind(instance);
    const resuming = instance.resume();
    instance.remote.bind(grant);
    const external = instance.remote.authorization;
    assert.equal(await resuming, "disconnected");
    assert.equal(instance.remote.authorization, external);
    assert.deepEqual(await createAuthorizationStorage({ database, store: "auth" }).keys(""), []);
    instance.remote.unbind();
  } finally { instance.dispose(); database.close(); globalThis.window = previousWindow; }
});
