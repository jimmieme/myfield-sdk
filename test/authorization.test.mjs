import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import { createAuthorizationClient, createAuthorizationStorage, createInstanceKey, ClientError } from "../src/index.ts";
import { buildApprovedCallback, decodeAuthRequestFragment } from "./auth-fixture.mjs";

const appId = "app.example.com", redirectUri = "https://app.example.com/note";
const failure = code => error => error instanceof ClientError && error.code === code;
async function setup(extra = {}) {
  const instanceKey = await createInstanceKey();
  const client = createAuthorizationClient({ appId, instanceKey, redirectUri, ...extra });
  const request = client.createRequest();
  const wire = decodeAuthRequestFragment(request.url);
  const callback = await buildApprovedCallback(wire, redirectUri);
  return { client, request, instanceKey, ...callback };
}

test("authorization returns the granted non-extractable data key with no persistence or HTTP", async () => {
  const { client, request, callbackUrl, rawBucketKey, instanceKey } = await setup();
  const context = await client.handleCallback(callbackUrl, request);
  assert.equal(context.instanceId, instanceKey.instanceId);
  assert.equal(context.apiBase, "https://api.example.test");
  assert.equal(context.bucketId, appId);
  assert.equal(context.resourceId, `urn:myfield:bucket:${appId}`);
  assert.equal(context.payloadKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", context.payloadKey));
  const iv = crypto.getRandomValues(new Uint8Array(12)), data = new TextEncoder().encode("shared data");
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, context.payloadKey, data);
  const expectedKey = await crypto.subtle.importKey("raw", rawBucketKey, "AES-GCM", false, ["decrypt"]);
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, expectedKey, encrypted)), data);
  const reopened = createAuthorizationClient({ appId, instanceKey, redirectUri });
  assert.equal((await reopened.handleCallback(callbackUrl, structuredClone(request))).instanceId, instanceKey.instanceId);
});

test("callback rejects wrong state, identity, destination, expired request and forged ciphertext", async () => {
  const { client, request, callbackUrl } = await setup();
  for (const mutate of [url => url.searchParams.set("state", "other"), url => { url.hostname = "evil.example"; }, url => { url.pathname = "/other"; }, url => { url.hash = "mf_auth_result=invalid"; }]) {
    const url = new URL(callbackUrl); mutate(url);
    await assert.rejects(client.handleCallback(url.href, request), failure("INVALID_AUTHORIZATION"));
  }
  await assert.rejects(client.handleCallback(callbackUrl, { ...request, createdAt: new Date(Date.now() - 601_000).toISOString() }), failure("INVALID_AUTHORIZATION"));
  await assert.rejects(client.handleCallback(callbackUrl, { ...request, instanceId: "inst_" + "0".repeat(32) }), failure("INVALID_AUTHORIZATION"));
  const denied = new URL(callbackUrl); denied.searchParams.set("mf_result", "denied"); denied.hash = "";
  await assert.rejects(client.handleCallback(denied.href, request), failure("AUTHORIZATION_DENIED"));
});

test("authorization uses the remote bucket and endpoint from the encrypted callback", async () => {
  const { client, request } = await setup();
  const result = await buildApprovedCallback(decodeAuthRequestFragment(request.url), redirectUri, { remoteBucketId: "remote.example.com" });
  const context = await client.handleCallback(result.callbackUrl, request);
  assert.equal(context.bucketId, "remote.example.com");
  assert.equal(context.resourceId, "urn:myfield:bucket:remote.example.com");
});

test("explicit storage persists identity, pending request and key across reopen", async () => {
  const name = crypto.randomUUID();
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name); req.onupgradeneeded = () => req.result.createObjectStore("auth");
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  let database = await open();
  const { client, request, callbackUrl, instanceKey } = await setup();
  let storage = createAuthorizationStorage({ database, store: "auth" });
  assert.deepEqual(await storage.keys(""), []);
  await storage.add("identity", instanceKey); await storage.set("pending", request);
  database.close(); database = await open(); storage = createAuthorizationStorage({ database, store: "auth" });
  const restored = createAuthorizationClient({ appId, instanceKey: await storage.get("identity"), redirectUri });
  const context = await restored.handleCallback(callbackUrl, await storage.get("pending"));
  assert.equal(await storage.get("grant"), null);
  await storage.set("grant", context); await storage.remove("pending");
  database.close(); database = await open(); storage = createAuthorizationStorage({ database, store: "auth" });
  const saved = await storage.get("grant");
  assert.equal(saved.payloadKey.extractable, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, context.payloadKey, new Uint8Array([42]));
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, saved.payloadKey, encrypted)), new Uint8Array([42]));
  database.close();
  await assert.rejects(storage.set("grant", context));
});

test("popup validates source and origin, handles cancellation and leaves storage to the caller", async () => {
  const original = globalThis.window;
  const listeners = new Set(); let popup, opened;
  globalThis.window = {
    location: new URL(redirectUri),
    open: url => { opened = url; return popup = { closed: false, close() { this.closed = true; } }; },
    addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn),
  };
  try {
    const key = await createInstanceKey();
    const client = createAuthorizationClient({ appId, instanceKey: key, authBase: "https://auth.example/auth/" });
    const promise = client.authorize();
    assert.equal(new URL(opened).searchParams.get("callbackTransport"), "popup");
    const { callbackUrl } = await buildApprovedCallback(decodeAuthRequestFragment(opened), redirectUri);
    const data = { type: "myfield.auth.callback", callbackUrl };
    for (const fn of listeners) fn({ source: {}, origin: "https://auth.example", data });
    for (const fn of listeners) fn({ source: popup, origin: "https://evil.example", data });
    assert.equal(listeners.size, 1);
    for (const fn of [...listeners]) fn({ source: popup, origin: "https://auth.example", data });
    const grant = await promise;
    assert.equal(grant.payloadKey.extractable, false); assert.equal(listeners.size, 0); assert.equal(popup.closed, true);
    const abort = new AbortController(); const cancelled = client.authorize({ signal: abort.signal }); abort.abort();
    await assert.rejects(cancelled, error => error.name === "AbortError");
    assert.equal(listeners.size, 0); assert.equal(popup.closed, true);
    globalThis.window.open = () => null;
    await assert.rejects(client.authorize(), failure("AUTHORIZATION_BLOCKED"));
  } finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
});


test("bad authorization inputs fail before navigation and never expose private JWK fields", async () => {
  const { instanceKey, client } = await setup();
  assert.throws(() => createAuthorizationClient(null), failure("INVALID_INPUT"));
  assert.throws(() => createAuthorizationStorage(null), failure("INVALID_INPUT"));
  assert.throws(() => client.createRequest(null), failure("INVALID_INPUT"));
  assert.throws(() => client.createRequest({ bucketId: undefined + ".." }), failure("INVALID_INPUT"));
  await assert.rejects(client.authorize(null), failure("INVALID_INPUT"));
  const invalid = createAuthorizationClient({ appId, instanceKey: { ...instanceKey,
    signingPublicJwk: { ...instanceKey.signingPublicJwk, d: "private" } }, redirectUri });
  assert.throws(() => invalid.createRequest(), failure("INVALID_INPUT"));
});
