import assert from "node:assert/strict";
import test from "node:test";
import { createBucketRemote, createSessionClient, createInstanceKey, ClientError } from "../src/index.ts";

const meta = { objectId: "settings/current", versionId: "v1", parentVersionIds: [], payloadHash: "sha256:opaque", extension: { kept: true } };
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
function fixture(handler) {
  const calls = [];
  let credentials = 0;
  const fetch = async (url, init) => {
    const call = { url: new URL(url), ...init, headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call, calls.length);
  };
  const remote = createBucketRemote({ apiBase: "https://api.example", mfid: "owner", bucketId: "bucket", fetch,
    getCredential: async () => ({ token: `token-${++credentials}` }) });
  return { remote, calls, fetch, credentials: () => credentials };
}
const expectError = (code, status) => error => error instanceof ClientError && error.code === code && error.status === status;

test("session creation performs the fixed signed handshake with its bound identity", async () => {
  const instanceKey = await createInstanceKey();
  const input = { mfid: "owner", resourceId: "urn:myfield:bucket:bucket" };
  const identity = { ...input, instanceId: instanceKey.instanceId };
  const challenge = { ok: true, challengeId: "challenge-id", challenge: "challenge", expiresAt: "later" };
  const session = { ok: true, ...identity, capabilities: ["read", "write"], credential: { carrier: "bearer", token: "token", expiresAt: "later" } };
  const { fetch, calls } = fixture(call => json(call.url.pathname.endsWith("challenge") ? challenge : session));
  const client = createSessionClient({ apiBase: "https://auth.example", instanceKey, fetch });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.createSession(input, { signal }), session);
  assert.deepEqual(calls.map(c => c.url.pathname), ["/v1/api/auth/instance-challenge", "/v1/api/auth/instance-session"]);
  assert.deepEqual(JSON.parse(calls[0].body), identity);
  const body = JSON.parse(calls[1].body);
  assert.equal(body.credentialCarrier, "bearer"); assert.equal(body.challengeId, challenge.challengeId);
  const publicKey = await crypto.subtle.importKey("jwk", instanceKey.signingPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const payload = { v: 1, type: "instance-proof", ...identity, challengeId: challenge.challengeId,
    challenge: challenge.challenge, signedAt: body.proof.signedAt };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
    Buffer.from(body.proof.signature, "base64url"), new TextEncoder().encode(canonical)), true);
  assert.ok(calls.every(c => c.signal === signal && c.credentials === "omit" && !c.headers.has("authorization")));
  await client.createSession(input);
  assert.equal(calls.length, 4, "each call performs a fresh handshake without caching");
});

test("session handshake stops on cancellation or malformed challenges", async () => {
  const instanceKey = await createInstanceKey();
  for (const abort of [true, false]) {
    const controller = new AbortController(); let calls = 0;
    const client = createSessionClient({ apiBase: "https://api.example", instanceKey, fetch: async () => {
      calls++;
      if (abort) controller.abort(new Error("cancel session"));
      return Response.json({ ok: true });
    } });
    await assert.rejects(client.createSession({ mfid: "owner", resourceId: "resource" }, { signal: controller.signal }),
      abort ? /cancel session/ : expectError("INVALID_RESPONSE", 200));
    assert.equal(calls, 1);
  }
  assert.throws(() => createSessionClient({ apiBase: "https://api.example" }), expectError("INVALID_INPUT"));
});

test("current uses miss=null, preserves metadata, and only requests ancestry explicitly", async () => {
  const { remote, calls } = fixture(call => json(call.url.searchParams.has("have")
    ? { versionId: "v2", headVersionMeta: { ...meta, versionId: "v2", parentVersionIds: ["v1"] }, history: ["v2", "v1"] }
    : { versionId: "v1", headVersionMeta: meta, extension: true }));
  assert.deepEqual((await remote.getCurrent(meta.objectId)).headVersionMeta, meta);
  assert.deepEqual((await remote.getCurrent(meta.objectId, { have: "v1" })).history, ["v2", "v1"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/v1/api/sync/buckets/bucket/objects/settings%2Fcurrent/current");
  assert.equal(calls[0].url.search, "?miss=null");
  assert.equal(calls[1].headers.get("authorization"), "Bearer token-2");
  assert.equal(calls[1].headers.get("x-myfield-mfid"), "owner");
});

test("only a valid null current is absence; fixed-version and payload 404 remain errors", async () => {
  const { remote } = fixture(call => call.url.pathname.endsWith("current")
    ? json({ versionId: null, headVersionMeta: null }) : json({ code: "SYNC_VERSION_NOT_FOUND", message: "Missing", requestId: "r1" }, 404));
  assert.equal(await remote.getCurrent("missing"), null);
  await assert.rejects(remote.getVersionMeta("missing", "v1"), expectError("SYNC_VERSION_NOT_FOUND", 404));
  await assert.rejects(remote.getPayload("missing", "v1"), expectError("SYNC_VERSION_NOT_FOUND", 404));
});

test("version history and feed expose exactly one page with opaque cursors", async () => {
  const { remote, calls } = fixture(call => {
    if (call.url.pathname.endsWith("meta")) return json({ ...meta, history: ["v1"], nextCursor: "opaque+/=" });
    if (call.url.pathname.endsWith("objects:index")) return json({ bucketId: "bucket", feedCursor: "index-cursor", hasMoreFeed: true, objects: [{ objectId: meta.objectId, versionId: "v1" }] });
    return json({ entries: [], cursor: "next", hasMore: true });
  });
  assert.deepEqual(await remote.getVersionMeta(meta.objectId, "v1"), { ...meta, history: ["v1"], nextCursor: "opaque+/=" });
  const page = await remote.listVersionHistory(meta.objectId, "v1", { cursor: "opaque+/=", limit: 2 });
  assert.equal(page.nextCursor, "opaque+/=");
  assert.equal(calls[1].url.searchParams.get("history"), "full");
  assert.equal(calls[1].url.searchParams.get("cursor"), "opaque+/=");
  assert.equal((await remote.getIndex()).feedCursor, "index-cursor");
  assert.equal((await remote.listFeed({ cursor: "opaque+/=", limit: 1 })).hasMore, true);
  assert.equal(calls.length, 4);
});

test("a null index cursor starts feed discovery instead of serializing cursor=null", async () => {
  const hint = { objectId: meta.objectId, versionId: meta.versionId };
  const { remote, calls } = fixture(call => {
    if (call.url.pathname.endsWith("objects:index")) return json({ bucketId: "bucket", feedCursor: null, hasMoreFeed: true, objects: [] });
    if (call.url.pathname.endsWith("meta")) return json({ ...meta, history: [meta.versionId], nextCursor: null });
    assert.equal(call.url.searchParams.has("cursor"), false);
    return json({ entries: [hint], cursor: "first-page", hasMore: false });
  });
  const index = await remote.getIndex();
  assert.equal(index.hasMoreFeed, true);
  const feed = await remote.listFeed({ cursor: index.feedCursor });
  assert.deepEqual(feed.entries, [hint]);
  assert.equal(feed.cursor, "first-page");
  await remote.listVersionHistory(meta.objectId, meta.versionId, { cursor: null });
  assert.equal(calls[2].url.searchParams.has("cursor"), false);
  assert.equal(calls[2].url.searchParams.get("history"), "full");
});

test("payload returns the original Response without consuming its body", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  const { remote } = fixture(() => response);
  assert.equal(await remote.getPayload(meta.objectId, "v1"), response);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("commit forwards nonempty and zero-byte payloads unchanged without interpreting deletion", async () => {
  const payload = new Uint8Array([1, 2, 3]);
  const { remote, calls } = fixture(() => json({ ok: true }));
  assert.deepEqual(await remote.commit({ meta, payload, expectedHeadVersionId: null }), { ok: true });
  assert.equal(calls[0].body, payload);
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].headers.get("x-myfield-version-meta"), "base64url")), meta);
  assert.equal(calls[0].headers.has("content-length"), false);
  assert.equal(calls[0].headers.has("x-myfield-expected-head-version-id"), false);
  assert.equal(calls[0].headers.get("content-type"), "application/octet-stream");
  const emptyVersion = { objectId: meta.objectId, versionId: "v2", parentVersionIds: ["v1"] };
  await remote.commit({ meta: emptyVersion, payload: new Blob([]), expectedHeadVersionId: "v1" });
  assert.equal(calls[1].body.size, 0);
  assert.equal(calls[1].headers.get("x-myfield-expected-head-version-id"), "v1");
  assert.equal(calls.length, 2);
});

test("CAS rejection is a result, with no hidden confirmation request or retry", async () => {
  for (const reason of ["version-mismatch", "conflict"]) {
    const { remote, calls } = fixture(() => json({ ok: false, reason }));
    assert.deepEqual(await remote.commit({ meta, payload: new Blob(["x"]), expectedHeadVersionId: null }), { ok: false, reason });
    assert.equal(calls.length, 1);
  }
});

test("malformed or unexpected HTTP 200 commit replies never acknowledge a write", async () => {
  for (const body of [{}, { ok: "true" }, { ok: false, reason: "unavailable" }, { ok: false }, [], null]) {
    const { remote } = fixture(() => json(body));
    await assert.rejects(remote.commit({ meta, payload: new Blob([]), expectedHeadVersionId: null }), expectError("INVALID_RESPONSE", 200));
  }
  const { remote } = fixture(() => new Response("not JSON"));
  await assert.rejects(remote.commit({ meta, payload: new Blob([]), expectedHeadVersionId: null }), expectError("INVALID_RESPONSE", 200));
});

test("HTTP errors expose protocol details and never trigger credential refresh", async () => {
  for (const status of [400, 401, 403, 413, 429, 503]) {
    const { remote, calls, credentials } = fixture(() => json({ code: "FAILED", message: "Rejected", requestId: "r1", details: { maxBytes: 42 } }, status, { "retry-after": "2" }));
    await assert.rejects(remote.commit({ meta, payload: new Blob([]), expectedHeadVersionId: null }), error => {
      assert.equal(error.code, "FAILED"); assert.equal(error.status, status); assert.equal(error.requestId, "r1");
      assert.equal(error.maxBytes, 42); assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.retryable, status === 429 || status >= 500);
      return true;
    });
    assert.equal(calls.length, 1); assert.equal(credentials(), 1);
  }
});

test("network errors retain causes; cancellation stays cancellation", async () => {
  const cause = new TypeError("Connection lost");
  const { remote, calls } = fixture(() => { throw cause; });
  await assert.rejects(remote.getCurrent("x"), error => error instanceof ClientError && error.code === "NETWORK_ERROR" && error.retryable && error.cause === cause && error.status === undefined);
  assert.equal(calls.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(remote.getCurrent("x", { signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(calls.length, 1);
});

test("writes reject dot IDs before requesting, reads preserve safe historical dotted IDs", async () => {
  const { remote, calls } = fixture(() => json({ ...meta, versionId: "v..1" }));
  for (const id of [".", "..", "a..b"]) {
    await assert.rejects(remote.commit({ meta: { ...meta, versionId: id }, payload: new Blob([]), expectedHeadVersionId: null }), expectError("INVALID_INPUT", undefined));
    await assert.rejects(remote.commit({ meta: { ...meta, objectId: id }, payload: new Blob([]), expectedHeadVersionId: null }), expectError("INVALID_INPUT", undefined));
  }
  assert.equal(calls.length, 0);
  assert.equal((await remote.getVersionMeta(meta.objectId, "v..1")).versionId, "v..1");
});

test("read routes reject exact dot segments instead of following normalized paths", async () => {
  const { remote, calls } = fixture(() => json(meta));
  for (const id of [".", ".."]) {
    await assert.rejects(remote.getVersionMeta(meta.objectId, id), expectError("INVALID_INPUT", undefined));
    await assert.rejects(remote.getPayload(id, "v1"), expectError("INVALID_INPUT", undefined));
  }
  assert.equal(calls.length, 0);
});

test("a response body network failure remains retryable rather than a JSON syntax error", async () => {
  const cause = new TypeError("Connection lost while reading");
  const { remote } = fixture(() => new Response(new ReadableStream({ start(controller) { controller.error(cause); } })));
  await assert.rejects(remote.getCurrent("a"), error => error instanceof ClientError && error.code === "NETWORK_ERROR" && error.cause === cause && error.retryable);
});

test("response identity and current history are checked without discarding unknown metadata", async () => {
  for (const body of [{ versionId: "v1", headVersionMeta: { ...meta, objectId: "other" } },
    { versionId: "v1", headVersionMeta: meta, history: ["other", "v1"] },
    { versionId: "v1", headVersionMeta: meta, history: ["v1", "v1"] }, { versionId: null }]) {
    const { remote } = fixture(() => json(body));
    await assert.rejects(remote.getCurrent(meta.objectId, { have: "v1" }), expectError("INVALID_RESPONSE", 200));
  }
});

function streamFixture(text, { close = true } = {}) {
  let cancelled = false;
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    if (close) controller.close();
  }, cancel() { cancelled = true; } });
  const setup = fixture(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  return { ...setup, cancelled: () => cancelled };
}

test("SSE exposes readiness, handles split UTF-8/CRLF, flattens batches and ends without reconnect", async () => {
  const hints = [{ objectId: "note:é", versionId: "v1" }, { objectId: "b", versionId: "v2" }];
  const { remote, calls } = streamFixture(`: keepalive\r\nevent: sync-ready\r\ndata: {}\r\n\r\nevent: sync-feed\r\ndata: ${JSON.stringify(hints[0])}\r\n\r\nevent: sync-feed\ndata: ${JSON.stringify({ entries: hints })}\n\n`);
  const received = [];
  for await (const hint of remote.watchFeed()) received.push(hint);
  assert.deepEqual(received, [{ type: "ready" }, ...[hints[0], ...hints].map(hint => ({ type: "change", ...hint }))]);
  assert.equal(calls.length, 1);
});

test("breaking SSE iteration cancels the reader", async () => {
  const hint = { objectId: "a", versionId: "v1" };
  const { remote, cancelled, calls } = streamFixture(`event: sync-ready\ndata: {}\n\nevent: sync-feed\ndata: ${JSON.stringify(hint)}\n\n`, { close: false });
  const events = remote.watchFeed();
  assert.deepEqual((await events.next()).value, { type: "ready" });
  for await (const value of events) { assert.deepEqual(value, { type: "change", ...hint }); break; }
  assert.equal(cancelled(), true);
  assert.equal(calls.length, 1);
});

test("aborting a pending SSE read cancels the connection without reconnect", async () => {
  const { remote, cancelled, calls } = streamFixture("", { close: false });
  const controller = new AbortController();
  const iterator = remote.watchFeed({ signal: controller.signal });
  const pending = iterator.next();
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal(cancelled(), true);
  assert.equal(calls.length, 1);
});

test("malformed SSE events throw protocol errors and release the connection", async () => {
  const { remote, cancelled } = streamFixture("event: sync-ready\ndata: {}\n\nevent: sync-feed\ndata: invalid\n\n", { close: false });
  await assert.rejects(async () => { for await (const hint of remote.watchFeed()) void hint; }, expectError("INVALID_RESPONSE", 200));
  assert.equal(cancelled(), true);
});


test("required IDs and CAS conditions fail before credentials or fetch; null have is omitted", async () => {
  const { remote, calls, credentials } = fixture(call => json(call.url.pathname.endsWith("meta") ? meta : { versionId: meta.versionId, headVersionMeta: meta }));
  for (const value of [undefined, null, 0, false, {}, "", " "]) {
    await assert.rejects(remote.getCurrent(value), expectError("INVALID_INPUT", undefined));
    await assert.rejects(remote.getVersionMeta(meta.objectId, value), expectError("INVALID_INPUT", undefined));
    await assert.rejects(remote.getPayload(value, meta.versionId), expectError("INVALID_INPUT", undefined));
    await assert.rejects(remote.commit({ meta: { ...meta, versionId: value }, payload: new Blob(), expectedHeadVersionId: null }), expectError("INVALID_INPUT", undefined));
    if (value !== null) await assert.rejects(remote.commit({ meta, payload: new Blob(), expectedHeadVersionId: value }), expectError("INVALID_INPUT", undefined));
    if (value != null) await assert.rejects(remote.getCurrent(meta.objectId, { have: value }), expectError("INVALID_INPUT", undefined));
  }
  assert.equal(calls.length, 0); assert.equal(credentials(), 0);
  await remote.getCurrent(meta.objectId, { have: null });
  assert.equal(calls[0].url.searchParams.has("have"), false);
  await remote.getCurrent(meta.objectId, { have: undefined });
  assert.equal(calls[1].url.searchParams.has("have"), false);
  await remote.getVersionMeta(meta.objectId, "v1");
  assert.equal(calls.length, 3);
});

test("HTTP clients reject non-origin apiBase without issuing a request", async () => {
  const instanceKey = await createInstanceKey();
  for (const apiBase of [undefined, null, "", "not a URL", "file:///tmp", "https://api.example/prefix", "https://api.example/?x=1", "https://api.example/#fragment", "https://user:pass@api.example"]) {
    const fetch = () => assert.fail("invalid configuration must not send a request");
    assert.throws(() => createSessionClient({ apiBase, fetch, instanceKey }), expectError("INVALID_INPUT", undefined));
    assert.throws(() => createBucketRemote({ apiBase, mfid: "owner", bucketId: "bucket", fetch, getCredential: () => assert.fail() }), expectError("INVALID_INPUT", undefined));
  }
  assert.ok(createSessionClient({ apiBase: "https://api.example/", instanceKey }));
});

test("current preserves null/empty history and accepts absent objects carrying history", async () => {
  for (const history of [null, []]) {
    const body = { versionId: meta.versionId, headVersionMeta: meta, history };
    const { remote } = fixture(() => json(body));
    assert.deepEqual(await remote.getCurrent(meta.objectId, { have: "older" }), body);
  }
  const { remote } = fixture(() => json({ versionId: null, headVersionMeta: null, history: [] }));
  assert.equal(await remote.getCurrent("missing", { have: "older" }), null);
});

test("SSE ready resolves before any change and both hint shapes discard envelope metadata", async () => {
  let controller;
  const hint = { objectId: "a", versionId: "v1" };
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const { remote, calls } = fixture(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  const iterator = remote.watchFeed();
  const first = iterator.next();
  controller.enqueue(new TextEncoder().encode("event: sync-ready\ndata: {}\n\n"));
  assert.deepEqual(await first, { done: false, value: { type: "ready" } });
  const envelope = { bucketId: "bucket", sourceInstanceId: "source", changedAt: 123 };
  controller.enqueue(new TextEncoder().encode(`event: sync-feed\ndata: ${JSON.stringify({ ...envelope, ...hint })}\n\nevent: sync-feed\ndata: ${JSON.stringify({ ...envelope, entries: [hint] })}\n\n`));
  assert.deepEqual((await iterator.next()).value, { type: "change", ...hint });
  assert.deepEqual((await iterator.next()).value, { type: "change", ...hint });
  await iterator.return();
  assert.equal(calls.length, 1);
});

test("SSE EOF or a change before readiness cannot mark subscription ready", async () => {
  for (const text of ["", 'event: sync-feed\ndata: {"objectId":"a","versionId":"v1"}\n\n']) {
    const { remote } = streamFixture(text);
    await assert.rejects(remote.watchFeed().next(), expectError("INVALID_RESPONSE", 200));
  }
});

test("current ancestry evidence accepts paths beyond the current Worker limit", async () => {
  const history = Array.from({ length: 300 }, (_, i) => `v${299 - i}`);
  const body = { versionId: history[0], headVersionMeta: { ...meta, versionId: history[0] }, history };
  const { remote } = fixture(() => json(body));
  assert.deepEqual(await remote.getCurrent(meta.objectId, { have: history.at(-1) }), body);
});

test("root exports contain protocol clients and supported local data APIs", async () => {
  const exports = await import("../src/index.ts");
  assert.deepEqual(Object.keys(exports).sort(), ["ClientError", "NotConnectedError", "OfflineError", "createAuthorizationClient", "createAuthorizationStorage", "createBucketRemote", "createInstance", "createInstanceKey", "createSessionClient"]);
});

test("legacy and custom schemas encode the same commit route without changing payload bytes", async () => {
  const { remote, calls } = fixture(() => json({ ok: true }));
  const payload = new Uint8Array([1, 2, 3]);
  const input = { meta, payload, expectedHeadVersionId: "base", headState: { headVersionId: meta.versionId, historyMap: { [meta.versionId]: ["base"] }, fieldSources: {} } };
  await remote.commit(input, { schema: "legacy" });
  const form = calls[0].body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(form.get("headState")), input.headState);
  assert.deepEqual(JSON.parse(form.get("versionMeta")), meta);
  assert.equal(form.get("expectedHeadVersionId"), "base");
  assert.deepEqual(new Uint8Array(await form.get("versionPayload").arrayBuffer()), payload);
  assert.equal(calls[0].headers.has("content-type"), false);
  await remote.commit(input, { schema: { encode: value => ({ body: value.payload, headers: { "x-schema": "custom" } }) } });
  assert.equal(calls[1].url.href, calls[0].url.href);
  assert.equal(calls[1].headers.get("x-schema"), "custom");
  assert.equal(calls[1].body, payload);
  await assert.rejects(remote.commit(input), expectError("INVALID_INPUT"));
});

test("legacy business failures and unknown replies never acknowledge uploads", async () => {
  for (const [reason, expected, status] of [["unavailable", "REMOTE_UNAVAILABLE", 503], ["invalid-input", "INVALID_INPUT", 400], ["unauthorized", "UNAUTHORIZED", 401], ["payload-too-large", "OBJECT_TOO_LARGE", 413], ["future-reason", "INVALID_RESPONSE", 200]]) {
    const { remote, calls } = fixture(() => json({ ok: false, reason }));
    await assert.rejects(remote.commit({ meta, payload: new Uint8Array(), expectedHeadVersionId: null }, { schema: "legacy" }), expectError(expected, status));
    assert.equal(calls.length, 1);
  }
});

test("getVersion combines two fixed-version requests without response metadata headers", async () => {
  const largeMeta = { ...meta, extension: "x".repeat(7000) };
  const { remote, calls } = fixture(call => call.url.pathname.endsWith("/meta")
    ? json(largeMeta) : new Response(new Uint8Array([1, 2, 3])));
  const signal = new AbortController().signal;
  const version = await remote.getVersion(meta.objectId, meta.versionId, { signal });
  assert.deepEqual(version.meta, largeMeta); assert.equal(version.payload.bodyUsed, false);
  assert.deepEqual(new Uint8Array(await version.payload.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url.pathname.split("/").at(-1)).sort(), ["meta", "payload"]);
  assert.ok(calls.every(call => call.signal === signal));
});

test("getVersion cancels unused payloads when metadata fails, including late responses", async () => {
  for (const delayed of [false, true]) {
    let cancelled = false, release;
    const payload = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const { remote, calls } = fixture(call => call.url.pathname.endsWith("/meta")
      ? json({ ...meta, versionId: "other" })
      : delayed ? new Promise(resolve => { release = () => resolve(payload); }) : payload);
    await assert.rejects(remote.getVersion(meta.objectId, meta.versionId), expectError("INVALID_RESPONSE", 200));
    if (delayed) release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true); assert.equal(calls.length, 2);
  }
});
