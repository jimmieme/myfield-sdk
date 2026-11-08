import { signInstanceChallenge } from "../src/crypto/instance.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { createInstance, createInstanceKey, ClientError } from "../src/index.ts";
import { createAuthStorage } from "../src/auth/storage.ts";
import { createInstanceAuthClient } from "../src/auth/instance.ts";
import { createMemoryStorageAdapter, createNamespacedMemoryStorageAdapter } from "../src/bucket/store.ts";
import { buildApprovedCallback, decodeAuthRequestFragment } from "./auth-fixture.mjs";

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const appId = "app.example.com";
const origin = "https://app.example.com";
const apiBase = "https://api.example.test";
const expiresAt = () => new Date(Date.now() + 7200_000).toISOString();
const code = value => error => error instanceof ClientError && error.code === value;
async function open(name = crypto.randomUUID(), upgrade = true) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => { if (upgrade) request.result.createObjectStore("auth"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function client(storage, extra = {}) {
  return createInstanceAuthClient({ appId, storage, apiBase, origin, redirectUri: origin + "/", authPageUrl: "https://myfield.test/auth/", ...extra });
}
async function authorize(auth, bucketId = appId, mfid) {
  let url;
  const wrapped = client(auth.storage, { ...auth.options, openAuthUrl: value => { url = value; } });
  await wrapped.authorize({ bucketId });
  const result = await buildApprovedCallback(decodeAuthRequestFragment(url), origin + "/", { bucketId, mfid });
  assert.equal((await wrapped.handleCallback(result.callbackUrl)).result, "approved");
  return wrapped;
}
function sessionFetch(calls, failure = false) {
  return async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    if (failure) throw new TypeError("offline");
    if (String(url).endsWith("instance-challenge")) return Response.json({ ok: true, challengeId: "challenge", challenge: "value", expiresAt: expiresAt() });
    const { mfid, resourceId, instanceId } = body;
    return Response.json({ ok: true, mfid, resourceId, instanceId, capabilities: ["read", "write"], credential: { carrier: "bearer", token: `${mfid}:${resourceId}`, expiresAt: expiresAt() } });
  };
}

test("pure instance keys are non-extractable and proofs verify", async () => {
  const instance = await createInstanceKey();
  assert.equal(instance.signingPrivateKey.extractable, false);
  assert.equal(instance.wrappingPrivateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", instance.signingPrivateKey));
  const input = { instance, challenge: "value", challengeId: "challenge", mfid: "ab".repeat(16), resourceId: "urn:myfield:bucket:notes" };
  const proof = await signInstanceChallenge(input);
  const payload = { v: 1, type: "instance-proof", instanceId: instance.instanceId, challenge: input.challenge, challengeId: input.challengeId, mfid: input.mfid, resourceId: input.resourceId, signedAt: proof.signedAt };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
  const key = await crypto.subtle.importKey("jwk", instance.signingPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(proof.signature, "base64url"), new TextEncoder().encode(canonical)), true);
});

test("application-owned IndexedDB stores survive reopening and concurrent identity initialization", async () => {
  const name = crypto.randomUUID();
  let database = await open(name);
  const storage = createAuthStorage({ database, store: "auth" });
  const [a, b] = await Promise.all([client(storage).ensureInstance(), client(createAuthStorage({ database, store: "auth" })).ensureInstance()]);
  assert.equal(a.instanceId, b.instanceId);
  assert.equal((await storage.keys("instance:")).filter(key => key.includes(":instance-key:")).length, 1);
  database.close(); database = await open(name);
  const restored = await client(createAuthStorage({ database, store: "auth" })).ensureInstance();
  assert.equal(restored.instanceId, a.instanceId);
  assert.equal(restored.signingPrivateKey.extractable, false);
  assert.equal(restored.wrappingPrivateKey.extractable, false);
  database.close();
});

test("missing or corrupt persisted identity fails without replacing the pointer", async () => {
  const storage = createMemoryStorageAdapter();
  const auth = client(storage);
  const key = await auth.ensureInstance();
  const record = (await storage.keys("instance:")).find(key => key.includes(":instance-key:"));
  await storage.remove(record);
  await assert.rejects(auth.ensureInstance(), code("INVALID_INSTANCE"));
  assert.equal((await storage.get(`instance:${appId}:active-instance:current`)).instanceId, key.instanceId);
  const invalid = client(createMemoryStorageAdapter(), { instanceKey: { ...key, instanceId: "inst_" + "0".repeat(32) } });
  await assert.rejects(invalid.ensureInstance(), code("INVALID_INPUT"));
});

test("storage failure and injected identity mismatch preserve the existing identity", async () => {
  const storage = createMemoryStorageAdapter();
  const key = await client(storage).ensureInstance();
  await assert.rejects(client(storage, { instanceKey: await createInstanceKey() }).ensureInstance(), code("IDENTITY_MISMATCH"));
  const failed = client({ ...storage, get: async () => { throw new Error("database closed"); } });
  await assert.rejects(failed.ensureInstance(), /database closed/);
  assert.equal((await client(storage).ensureInstance()).instanceId, key.instanceId);
});

test("getSession never creates a missing identity or opens authorization", async () => {
  const storage = createMemoryStorageAdapter();
  const auth = client(storage, { fetchImpl: () => { throw new Error("unexpected request"); }, openAuthUrl: () => { throw new Error("unexpected UI"); } });
  await assert.rejects(auth.getSession(appId), code("NOT_AUTHORIZED"));
  assert.deepEqual(await storage.keys(""), []);
});

test("session refresh coalesces across handles and isolates bucket identities", async () => {
  const storage = createMemoryStorageAdapter(); const calls = [];
  const fetchImpl = sessionFetch(calls);
  const a = await authorize({ storage, options: { fetchImpl } });
  const otherId = "other.example.com";
  await authorize({ storage, options: { fetchImpl } }, otherId, "cd".repeat(16));
  const b = client(storage, { fetchImpl });
  const [first, joined] = await Promise.all([a.getSession(appId, { forceRefresh: true }), b.getSession(appId, { forceRefresh: true })]);
  assert.equal(first.token, joined.token);
  assert.equal(calls.length, 2);
  const second = await b.getSession(otherId);
  assert.notEqual(first.token, second.token);
  assert.equal(calls.length, 4);
  assert.equal((await a.getSession(appId)).token, first.token);
  assert.equal(calls.length, 4);
});

test("failed refresh keeps authorization and persisted keys intact", async () => {
  const storage = createMemoryStorageAdapter();
  const auth = await authorize({ storage, options: { fetchImpl: sessionFetch([], true) } });
  const before = await storage.keys("");
  await assert.rejects(auth.getSession(appId), code("NETWORK_ERROR"));
  assert.ok(await auth.getContext(appId));
  assert.deepEqual(await storage.keys(""), before);
});

test("session refresh does not resurrect authorization after disconnect", async () => {
  const storage = createMemoryStorageAdapter(); let continueFetch; let started;
  const barrier = new Promise(resolve => { started = resolve; });
  const auth = await authorize({ storage, options: { fetchImpl: async (...args) => {
    started(); await new Promise(resolve => { continueFetch = resolve; });
    return sessionFetch([])(...args);
  } } });
  const pending = auth.getSession(appId);
  await barrier;
  await auth.clearContext(appId);
  const resume = continueFetch;
  // Only the challenge is held; the session exchange can proceed immediately.
  const interval = setInterval(() => continueFetch?.(), 1);
  resume();
  try { await assert.rejects(pending, code("AUTHORIZATION_CHANGED")); }
  finally { clearInterval(interval); }
  assert.equal(await auth.getContext(appId), null);
  assert.equal((await storage.keys("")).some(key => key.includes(":session:")), false);
});

test("appId defaults namespace and bucket without touching auth during local operations", async () => {
  const database = await open(); const authStorage = { database, store: "auth" };
  const instance = createInstance("notes.example", { storage: "memory", authStorage });
  assert.equal(instance.namespace, "notes.example");
  assert.equal(instance.createBucket().id, "notes.example");
  assert.equal(instance.createBucket(), instance.createBucket({ id: "notes.example" }));
  assert.equal(instance.createBucket({ id: "other" }).id, "other");
  await instance.createBucket().put("one", { title: "offline" });
  assert.deepEqual(await createAuthStorage(authStorage).keys(""), []);
  await assert.rejects(instance.getSession(), code("NOT_AUTHORIZED"));
  assert.deepEqual(await createAuthStorage(authStorage).keys(""), []);
  const overridden = createInstance("notes", { namespace: "separate", storage: "memory" });
  assert.equal(overridden.namespace, "separate");
  assert.equal(overridden.createBucket().id, "notes");
  database.close();
});

test("listener failures do not reject writes or suppress remaining listeners", async () => {
  const bucket = createInstance(crypto.randomUUID(), { storage: "memory" }).createBucket();
  const seen = [];
  bucket.on("change", () => { throw new Error("handler failed"); });
  bucket.on("change", async () => { throw new Error("async handler failed"); });
  bucket.on("change", id => seen.push(id));
  await bucket.put("one", { title: "kept" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(seen.includes("one"));
  assert.deepEqual(await bucket.get("one"), { title: "kept" });
});

test("connect reuses active or saved authorization; explicit disconnect permits new authorization", async () => {
  const database = await open();
  const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
  const listeners = new Set(); let openings = 0; let rejectFlow;
  const calls = []; const instanceKey = await createInstanceKey();
  const browser = {
    location: new URL(origin + "/"), screenX: 0, screenY: 0, outerWidth: 1000, outerHeight: 800,
    addEventListener: (name, fn) => { if (name === "message") listeners.add(fn); },
    removeEventListener: (name, fn) => listeners.delete(fn),
    history: { replaceState: () => {} },
    open: () => {
      openings++;
      const popup = { closed: false, document: { title: "", body: {} }, focus() {}, close() { this.closed = true; } };
      popup.location = { set href(value) {
        void (async () => {
          const wire = decodeAuthRequestFragment(value);
          assert.equal(wire.client_id, "notes.example");
          assert.equal(wire.mf_instance_id, instanceKey.instanceId);
          const { callbackUrl } = await buildApprovedCallback(wire, origin + "/", { bucketId: "notes.example" });
          for (const handler of [...listeners]) handler({ source: popup, origin: "https://myfield.test", data: { type: "myfield.auth.callback", callbackUrl } });
        })().catch(error => rejectFlow(error));
      } };
      return popup;
    },
  };
  globalThis.window = browser;
  globalThis.fetch = async (url, init) => String(url).includes("/v1/api/auth/")
    ? sessionFetch(calls)(url, init)
    : Response.json({ versionId: null, headVersionMeta: null });
  const settings = { storage: "memory", authStorage: { database, store: "auth" }, instanceKey, authBase: "https://myfield.test/auth/" };
  const instance = createInstance("notes.example", settings); const bucket = instance.createBucket();
  const guard = promise => Promise.race([promise, new Promise((_, reject) => { rejectFlow = reject; })]);
  try {
    const connecting = instance.connect({ autoSync: false });
    assert.throws(() => instance.remote.unbind(), code("REMOTE_MANAGED"));
    const grant = await guard(connecting);
    assert.throws(() => instance.remote.unbind(), code("REMOTE_MANAGED"));
    assert.throws(() => instance.remote.bind(grant), code("REMOTE_MANAGED"));
    assert.equal(grant.instanceId, instanceKey.instanceId);
    assert.equal(grant.bucketId, "notes.example");
    assert.equal(grant.apiBase, apiBase);
    assert.equal(grant.payloadKey.extractable, false);
    assert.equal(instance.remote.authorization.mfid, grant.mfid);
    assert.equal(await instance.remote.bucket.getCurrent("opaque"), null);
    assert.ok(grant.keyId);
    assert.equal(openings, 1);
    assert.equal(await bucket.connect(), "connected");
    assert.equal(openings, 1);
    const reopened = createInstance("notes.example", settings);
    assert.equal((await reopened.getSession()).token, (await grant.getSession()).token);
    assert.equal(calls.length, 2);
    assert.equal(openings, 1);
    const states = [];
    const stop = instance.on("state", value => states.push(value));
    await guard(instance.connect({ autoSync: false }));
    assert.equal(openings, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(states, []);
    await reopened.connect({ autoSync: false });
    assert.equal(openings, 1);
    assert.equal(calls.length, 2);
    await instance.disconnect();
    assert.equal(instance.remote.authorization, null);
    assert.equal(instance.instanceKey.instanceId, instanceKey.instanceId);
    assert.deepEqual(states, ["disconnected"]);
    stop();
    await assert.rejects(reopened.getSession(), code("NOT_AUTHORIZED"));
    await assert.rejects(grant.getSession(), code("NOT_AUTHORIZED"));
    await guard(instance.connect({ autoSync: false }));
    assert.equal(openings, 2);
    await bucket.disconnect();
    reopened.createBucket().dispose();
  } finally {
    bucket.dispose(); instance.createBucket().dispose(); database.close();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});


test("original namespace records remain readable through the composed session path", async () => {
  const namespace = "legacyrecords";
  const base = createNamespacedMemoryStorageAdapter(`myfield-sdk:${namespace}`);
  const storage = {
    get: key => base.get(`auth:${key}`), set: (key, value) => base.set(`auth:${key}`, value),
    remove: key => base.remove(`auth:${key}`), keys: async prefix => (await base.keys(`auth:${prefix}`)).map(key => key.slice(5)),
  };
  await authorize({ storage });
  const before = await base.keys("auth:");
  const originalWindow = globalThis.window; const originalFetch = globalThis.fetch; const calls = [];
  globalThis.window = { location: new URL(origin + "/"), addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = sessionFetch(calls);
  const instance = createInstance({ namespace, storage: "memory" });
  try {
    assert.equal((await instance.getSession({ bucketId: appId })).carrier, "bearer");
    const after = await base.keys("auth:");
    assert.ok(before.every(key => after.includes(key)));
    assert.equal(after.filter(key => key.includes(":instance-key:")).length, 1);
    assert.equal(calls.length, 2);
  } finally {
    instance.createBucket({ id: appId }).dispose();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("connect shares first authorization but preserves each API error contract; restore failures never open a popup", async t => {
  const database = await open();
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  const listeners = new Set(), calls = [];
  let outcome = "approved", popup, opened, failFlow, openings = 0;
  const bucketId = "reauth.example.com";
  t.mock.timers.enable({ apis: ["setInterval"] });
  globalThis.window = {
    location: new URL(origin + "/"), screenX: 0, screenY: 0, outerWidth: 1000, outerHeight: 800,
    addEventListener: (name, fn) => { if (name === "message") listeners.add(fn); },
    removeEventListener: (name, fn) => listeners.delete(fn), history: { replaceState() {} },
    open: () => {
      openings++;
      const current = popup = { closed: false, document: { body: {} }, focus() {}, close() { this.closed = true; } };
      current.location = { set href(value) {
        const wire = decodeAuthRequestFragment(value); opened?.();
        if (outcome === "close") return;
        void (async () => {
          let { callbackUrl } = await buildApprovedCallback(wire, origin + "/", { bucketId });
          const url = new URL(callbackUrl);
          if (outcome === "denied") { url.searchParams.set("mf_result", "denied"); url.hash = ""; }
          if (outcome === "invalid") url.hash = "mf_auth_result=invalid";
          if (outcome === "unmatched") url.searchParams.set("state", "another-request");
          for (const listener of [...listeners]) listener({ source: current, origin: "https://myfield.test", data: { type: "myfield.auth.callback", callbackUrl: url.href } });
        })().catch(error => failFlow(error));
      } };
      return current;
    },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/api/auth/")) {
      if (outcome === "session-error") return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      return sessionFetch(calls)(url, init);
    }
    if (outcome === "head-error" && String(url).includes("/current")) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    if (String(url).includes("objects:index")) { return Response.json({ bucketId, objects: [], feedCursor: "c0", hasMoreFeed: false }); }
    if (String(url).includes("/feed")) return Response.json({ entries: [], cursor: "c0", hasMore: false });
    return Response.json({ versionId: null, headVersionMeta: null });
  };
  const settings = { storage: "memory", authStorage: { database, store: "auth" }, authBase: "https://myfield.test/auth/" };
  const instances = [];
  const make = () => { const instance = createInstance(bucketId, settings); instances.push(instance); return instance; };
  const storage = createAuthStorage({ database, store: "auth" });
  const guard = promise => Promise.race([promise, new Promise((_, reject) => { failFlow = reject; })]);
  try {
    const first = make();
    await guard(first.connect({ autoSync: false }));
    first.createBucket().dispose();
    const contextKey = (await storage.keys("")).find(key => key.includes(":context:"));
    const context = await storage.get(contextKey);
    const restoring = make(), bucket = restoring.createBucket();
    const initialOpenings = openings;
    for (const [result, errorCode] of [["session-error", "UNAVAILABLE"], ["head-error", "INSTANCE_ERROR"]]) {
      outcome = result;
      for (const key of await storage.keys("")) if (key.includes(":session:")) await storage.remove(key);
      const previousAuthorization = restoring.remote.authorization;
      const modern = assert.rejects(restoring.connect({ autoSync: false }), code(errorCode));
      const legacy = bucket.connect({ autoSync: false });
      await modern;
      assert.equal(await legacy, "disconnected");
      assert.equal(openings, initialOpenings);
      assert.deepEqual(await storage.get(contextKey), context);
      assert.equal(restoring.remote.authorization, previousAuthorization);
    }
    outcome = "approved";
    await restoring.connect({ autoSync: false });
    assert.equal(openings, initialOpenings);
    await bucket.disconnect();
    for (const legacyFirst of [false, true]) {
      for (const [result, errorCode] of [["close", "AUTHORIZATION_CANCELLED"], ["denied", "AUTHORIZATION_DENIED"], ["invalid", "AUTHORIZATION_FAILED"], ["unmatched", "INVALID_AUTHORIZATION"]]) {
        outcome = result;
        const instance = make(), local = instance.createBucket();
        const didOpen = new Promise(resolve => { opened = resolve; });
        const previousAuthorization = instance.remote.authorization;
        let legacy, modern;
        if (legacyFirst) { legacy = local.connect({ autoSync: false }); modern = instance.connect({ autoSync: false }); }
        else { modern = instance.connect({ autoSync: false }); legacy = local.connect({ autoSync: false }); }
        const rejected = assert.rejects(guard(modern), code(errorCode));
        await didOpen;
        if (result === "close") { popup.close(); t.mock.timers.tick(500); }
        await rejected;
        assert.equal(await legacy, "disconnected");
        assert.equal(local.state, "disconnected");
        assert.equal(instance.remote.authorization, previousAuthorization);
        assert.equal(await storage.get(contextKey), null);
        local.dispose();
      }
    }
  } finally {
    for (const instance of instances) instance.createBucket().dispose();
    database.close(); t.mock.timers.reset();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("identity replacement rejects a callback before context writes and cleans only its own pending state", async () => {
  for (const newerRequest of [false, true]) {
    const base = createMemoryStorageAdapter(); let captured, replacePending = false, pendingKey;
    const storage = { ...base, async get(key) {
      const value = await base.get(key);
      if (replacePending && key.endsWith(":active-instance:current")) {
        replacePending = false;
        if (newerRequest) await base.set(pendingKey, { v: 1, requestId: "newer-request" });
      }
      return value;
    } };
    const auth = await authorize({ storage });
    const context = await auth.getContext(appId);
    const contextKey = (await base.keys("")).find(key => key.includes(":context:"));
    const authorizing = client(storage, { openAuthUrl: url => { captured = url; } });
    await authorizing.authorize({ bucketId: appId });
    const wire = decodeAuthRequestFragment(captured);
    const { callbackUrl } = await buildApprovedCallback(wire, origin + "/");
    const pointerKey = (await base.keys("")).find(key => key.includes(":callback-pointer:"));
    pendingKey = (await base.get(pointerKey)).pendingKey;
    const replacement = await createInstanceKey();
    await base.set(`instance:${appId}:instance-key:${replacement.instanceId}`, replacement);
    await base.set(`instance:${appId}:active-instance:current`, { v: 1, instanceId: replacement.instanceId });
    replacePending = true;
    await assert.rejects(authorizing.handleCallback(callbackUrl), code("IDENTITY_MISMATCH"));
    assert.deepEqual(await base.get(contextKey), context);
    assert.equal((await base.keys("")).filter(key => key.includes(":context:")).length, 1);
    assert.equal(await base.get(pointerKey), null);
    assert.equal((await base.get(pendingKey))?.requestId ?? null, newerRequest ? "newer-request" : null);
  }
});

test("createBucket preserves legacy trimming and coercion with canonical handle reuse", () => {
  for (const instance of [createInstance({ namespace: "trimcompat", storage: "memory" }), createInstance("trim.example.com", { storage: "memory" })]) {
    assert.equal(instance.createBucket({ id: " notes " }).id, "notes");
    assert.equal(instance.createBucket({ id: " notes " }), instance.createBucket({ id: "notes" }));
    assert.equal(instance.createBucket({ id: 42 }).id, "42");
    assert.equal(instance.createBucket().id, instance.appId);
    assert.throws(() => instance.createBucket({ id: "   " }), code("INVALID_INPUT"));
    for (const id of ["notes", "42", instance.appId]) instance.createBucket({ id }).dispose();
  }
});


test("getSession ignores callback URLs; resume explicitly consumes the validated callback", async () => {
  const database = await open();
  const target = createAuthStorage({ database, store: "auth" });
  const prefix = `instance-scope:${appId}:`;
  const storage = {
    get: key => target.get(prefix + key), set: (key, value) => target.set(prefix + key, value),
    add: (key, value) => target.add(prefix + key, value), remove: key => target.remove(prefix + key),
    keys: async key => (await target.keys(prefix + key)).map(value => value.slice(prefix.length)),
  };
  const auth = await authorize({ storage });
  const original = await auth.getContext(appId);
  let url;
  const next = client(storage, { openAuthUrl: value => { url = value; } });
  await next.authorize({ bucketId: appId });
  const { callbackUrl } = await buildApprovedCallback(decodeAuthRequestFragment(url), origin + "/", { mfid: "cd".repeat(16) });
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  let urlWrites = 0;
  const browser = { location: new URL(callbackUrl), addEventListener() {}, removeEventListener() {},
    history: { replaceState(_state, _title, value) { urlWrites++; browser.location = new URL(value); } } };
  globalThis.window = browser;
  globalThis.fetch = async (url, init) => String(url).includes("/v1/api/auth/")
    ? sessionFetch([])(url, init) : Response.json({ versionId: null, headVersionMeta: null });
  const instance = createInstance(appId, { storage: "memory", authStorage: { database, store: "auth" } });
  try {
    const beforeKeys = await storage.keys("");
    for (const href of [callbackUrl, callbackUrl.replace("mf_auth_result=", "mf_auth_result=bad")]) {
      browser.location = new URL(href);
      const credential = await instance.getSession();
      assert.equal(credential.token.split(":")[0], original.mfid);
      assert.deepEqual(await auth.getContext(appId), original);
      assert.equal(browser.location.href, href);
      assert.equal(urlWrites, 0);
    }
    assert.deepEqual((await storage.keys("")).filter(key => key.includes(":pending-auth:") || key.includes(":callback-pointer:")),
      beforeKeys.filter(key => key.includes(":pending-auth:") || key.includes(":callback-pointer:")));
    browser.location = new URL(callbackUrl);
    await auth.clearContext(appId);
    await assert.rejects(instance.getSession(), code("NOT_AUTHORIZED"));
    assert.equal(browser.location.href, callbackUrl);
    assert.equal(urlWrites, 0);
    assert.equal(await instance.resume(), "connected");
    assert.equal((await auth.getContext(appId)).mfid, "cd".repeat(16));
    assert.equal(browser.location.hash, "");
    assert.equal(urlWrites, 1);
  } finally {
    instance.createBucket().dispose(); database.close();
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});


function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function savedAuthorization(database) {
  const store = createAuthStorage({ database, store: "auth" }), prefix = `instance-scope:${appId}:`;
  const storage = {
    get: key => store.get(prefix + key), set: (key, value) => store.set(prefix + key, value),
    add: (key, value) => store.add(prefix + key, value), remove: key => store.remove(prefix + key),
    keys: async key => (await store.keys(prefix + key)).map(value => value.slice(prefix.length)),
  };
  await authorize({ storage });
}
function quietBrowser() {
  return { location: new URL(origin + "/"), addEventListener() {}, removeEventListener() {},
    open() { assert.fail("unexpected authorization window"); }, history: { replaceState() {} } };
}

test("concurrent resume failures preserve successful getSession bindings in either completion order", async t => {
  for (const order of ["session-first", "resume-first"]) await t.test(order, async () => {
    const database = await open(), previousWindow = globalThis.window;
    globalThis.window = quietBrowser();
    await savedAuthorization(database);
    const headEntered = deferred(), headRelease = deferred(), sessionEntered = deferred(), sessionRelease = deferred();
    let holdSession = false;
    const exchange = sessionFetch([]);
    const instance = createInstance(appId, { storage: "memory", authStorage: { database, store: "auth" }, fetch: async (url, init) => {
      if (String(url).includes("/current")) {
        headEntered.resolve(); await headRelease.promise;
        return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      }
      if (holdSession && String(url).endsWith("instance-session")) { sessionEntered.resolve(); await sessionRelease.promise; }
      return exchange(url, init);
    } });
    try {
      await instance.getSession();
      const original = instance.remote.authorization;
      const resuming = instance.resume();
      await headEntered.promise;
      holdSession = true;
      const refreshing = instance.getSession({ forceRefresh: true });
      await sessionEntered.promise;
      if (order === "resume-first") {
        headRelease.resolve(); assert.equal(await resuming, "disconnected");
        assert.equal(instance.remote.authorization, original);
      }
      sessionRelease.resolve(); await refreshing;
      const published = instance.remote.authorization;
      assert.ok(published); assert.notEqual(published, original);
      if (order === "session-first") { headRelease.resolve(); assert.equal(await resuming, "disconnected"); }
      assert.equal(instance.remote.authorization, published);
      assert.throws(() => instance.remote.unbind(), code("REMOTE_MANAGED"));
    } finally { headRelease.resolve(); sessionRelease.resolve(); instance.dispose(); database.close(); globalThis.window = previousWindow; }
  });
});

test("disconnect invalidates delayed recovery without clearing a subsequent external binding", async () => {
  const database = await open(), previousWindow = globalThis.window;
  globalThis.window = quietBrowser();
  await savedAuthorization(database);
  const headEntered = deferred(), headRelease = deferred(), sessionEntered = deferred(), sessionRelease = deferred();
  let holdSession = false;
  const exchange = sessionFetch([]);
  const instance = createInstance(appId, { storage: "memory", authStorage: { database, store: "auth" }, fetch: async (url, init) => {
    if (String(url).includes("/current")) {
      headEntered.resolve(); await headRelease.promise;
      return Response.json({ versionId: null, headVersionMeta: null });
    }
    if (holdSession && String(url).endsWith("instance-session")) { sessionEntered.resolve(); await sessionRelease.promise; }
    return exchange(url, init);
  } });
  try {
    await instance.getSession(); const grant = instance.remote.authorization;
    const resuming = instance.resume(); await headEntered.promise;
    holdSession = true;
    const refreshing = assert.rejects(instance.getSession({ forceRefresh: true }), code("AUTHORIZATION_CHANGED"));
    await sessionEntered.promise;
    await instance.disconnect();
    instance.remote.bind(grant); const external = instance.remote.authorization;
    headRelease.resolve(); sessionRelease.resolve();
    await refreshing;
    assert.equal(await resuming, "disconnected");
    assert.equal(instance.remote.authorization, external);
    instance.remote.unbind();
  } finally { headRelease.resolve(); sessionRelease.resolve(); instance.dispose(); database.close(); globalThis.window = previousWindow; }
});

test("bucket key and remote grant resource must agree before caching access", async () => {
  const storage = createMemoryStorageAdapter();
  const auth = await authorize({ storage });
  const key = (await storage.keys("")).find(value => value.includes(":context:"));
  const context = await storage.get(key);
  context.remoteResourceId = "urn:myfield:bucket:another.example.com";
  context.bucketAccessGrant.resourceId = context.remoteResourceId;
  await storage.set(key, context);
  const reopened = client(storage);
  await assert.rejects(reopened.getBucketAccess(appId), code("INVALID_AUTHORIZATION"));
  assert.deepEqual(await storage.get(key), context);
});
