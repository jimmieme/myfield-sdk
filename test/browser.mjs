import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildApprovedCallback, decodeAuthRequestFragment } from "./auth-fixture.mjs";

assert.ok(process.argv[2], "Usage: npm run test:browser -- /path/to/myfield");
const root = path.resolve(process.argv[2]);
const load = relative => import(pathToFileURL(path.join(root, relative)));
const { resolveChromeBinary } = await load("scripts/lib/chrome-for-testing.mjs");
const { CdpClient } = await load("scripts/lib/cdp-client.mjs");
const binary = resolveChromeBinary({ startDir: root });
assert.ok(binary.path, binary.installHint);
const sdk = await readFile(new URL("../dist/index.js", import.meta.url));
const objects = new Map();
let failRequests = false;
let commits = 0, dropNextAck = false, sessionRequests = 0, credentialLifetimeMs = 7200_000;
async function mockApi(request, response, url) {
  if (failRequests) { response.statusCode = 503; response.end('{"error":"test offline"}'); return; }
  let bytes = Buffer.alloc(0); for await (const chunk of request) bytes = Buffer.concat([bytes, chunk]);
  const route = url.pathname.slice("/mock-api".length);
  let result;
  if (route.endsWith("/instance-challenge")) result = { ok: true, challengeId: "browser-challenge", challenge: "browser-proof", expiresAt: new Date(Date.now() + 60000).toISOString() };
  else if (route.endsWith("/instance-session")) {
    sessionRequests++;
    const { mfid, instanceId, resourceId, proof } = JSON.parse(bytes);
    assert.ok(proof.signature);
    result = { ok: true, mfid, instanceId, resourceId, capabilities: ["read", "write"],
      credential: { carrier: "bearer", token: "browser-token", expiresAt: new Date(Date.now() + credentialLifetimeMs).toISOString() } };
  } else {
    const match = route.match(/\/buckets\/([^/]+)\/(.*)/); assert.ok(match, route);
    const bucketId = decodeURIComponent(match[1]); const suffix = match[2];
    const key = (id) => `${bucketId}:${id}`;
    if (suffix === "objects:index") result = { bucketId, feedCursor: "c0", hasMoreFeed: false,
      objects: [...objects.values()].filter(row => row.bucketId === bucketId).map(row => ({ objectId: row.meta.objectId, versionId: row.meta.versionId })) };
    else if (suffix === "feed") result = { entries: [], cursor: "c0", hasMore: false };
    else if (request.method === "POST") {
      let meta, payload, expected;
      if (request.headers["content-type"]?.startsWith("multipart/form-data")) {
        const form = await new Request(url, { method: "POST", headers: request.headers, body: bytes }).formData();
        meta = JSON.parse(form.get("versionMeta")); payload = Buffer.from(await form.get("versionPayload").arrayBuffer()); expected = form.get("expectedHeadVersionId");
      } else { meta = JSON.parse(Buffer.from(request.headers["x-myfield-version-meta"], "base64url")); payload = bytes; expected = request.headers["x-myfield-expected-head-version-id"] ?? null; }
      if (expected !== (objects.get(key(meta.objectId))?.meta.versionId ?? null)) result = { ok: false, reason: "version-mismatch" };
      else {
        assert.equal(payload.includes(Buffer.from("Example remote saved")), false);
        objects.set(key(meta.objectId), { bucketId, meta, payload }); commits++; result = { ok: true };
        if (dropNextAck) { dropNextAck = false; response.destroy(); return; }
      }
    } else if (suffix.endsWith("/current")) {
      const id = decodeURIComponent(suffix.slice("objects/".length, -"/current".length));
      const row = objects.get(key(id)); result = { versionId: row?.meta.versionId ?? null, headVersionMeta: row?.meta ?? null };
    } else if (suffix.endsWith("/meta")) {
      const id = decodeURIComponent(suffix.split("/")[1]); result = objects.get(key(id)).meta;
    } else if (suffix.endsWith("/payload")) {
      const id = decodeURIComponent(suffix.split("/")[1]);
      const row = objects.get(key(id));
      response.end(row.payload); return;
    } else throw new Error(`Unhandled mock route ${route}`);
  }
  response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/mock-api/")) { await mockApi(request, response, url); return; }
    if (url.pathname.startsWith("/examples/")) {
      assert.match(url.pathname, /^\/examples\/((local|remote)-api\.(html|js)|note-codec\.js)$/);
      response.setHeader("content-type", url.pathname.endsWith(".js") ? "text/javascript" : "text/html");
      response.end(await readFile(new URL(".." + url.pathname, import.meta.url))); return;
    }
    if (url.pathname === "/dist/index.js") { response.setHeader("content-type", "text/javascript"); response.end(sdk); return; }
    if (url.pathname === "/sdk.js") { response.setHeader("content-type", "text/javascript"); response.end(sdk); return; }
    if (url.pathname === "/callback" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const wire = decodeAuthRequestFragment(body);
      const { callbackUrl } = await buildApprovedCallback(wire, wire.redirect_uri, { bucketId: wire.resource_id.slice("urn:myfield:bucket:".length) });
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ callbackUrl })); return;
    }
    if (url.pathname === "/auth/") {
      response.end(`<script type="module">const {callbackUrl}=await(await fetch('/callback',{method:'POST',body:location.href})).json();if(new URL(location.href).searchParams.get('callbackTransport')==='same-tab')location.href=callbackUrl;else opener.postMessage({type:'myfield.auth.callback',callbackUrl},location.origin);</script>`); return;
    }
    if (url.pathname === "/redirect-test") {
      response.end(`<button id="connect">Connect</button><script type="module">import * as sdk from '/sdk.js';(${redirectPage.toString()})(sdk).catch(error=>{window.result={error:error.stack}})</script>`); return;
    }
    response.end(`<button id="connect">Connect</button><script type="module">import * as sdk from '/sdk.js';(${page.toString()})(sdk).catch(error=>{window.result={error:error.stack}})</script>`);
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), "sdk-browser-"));
const browser = spawn(binary.path, ["--headless=new", "--disable-gpu", "--disable-popup-blocking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let cdp;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, "Chrome must start");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  assert.match(version.Browser, /Chrome/);
  cdp = await CdpClient.connect(version.webSocketDebuggerUrl, { sendTimeoutMs: 10000 });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  for (const phase of [1, 2]) {
    await cdp.send("Page.navigate", { url: `${origin}/?phase=${phase}` }, sessionId);
    let result;
    for (let attempt = 0; attempt < 200; attempt++) {
      const evaluation = await cdp.send("Runtime.evaluate", { expression: "window.result", returnByValue: true }, sessionId);
      result = evaluation.result.value;
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(result, `browser phase ${phase} timed out`);
    assert.equal(result.error, undefined, result.error);
    console.log(`PASS Chrome phase ${phase}: ${JSON.stringify(result)}`);
  }
  await cdp.send("Page.navigate", { url: `${origin}/redirect-test` }, sessionId);
  let redirectResult;
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await cdp.send("Runtime.evaluate", { expression: "window.result", returnByValue: true }, sessionId);
    redirectResult = value.result.value;
    if (redirectResult) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(redirectResult, "same-tab callback must return to the app");
  assert.equal(redirectResult.error, undefined, redirectResult.error);
  assert.equal(redirectResult.originalIdentity, true);
  assert.equal(redirectResult.unbound, true);
  console.log("PASS native browser same-tab navigation, IndexedDB pending/key restoration and URL cleanup");
  console.log(`PASS native browser authorization/key persistence: ${version.Browser}`);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, init) => {
      const parsed = new URL(url, location.href);
      return nativeFetch(parsed.pathname.startsWith('/v1/api/') ? '/mock-api' + parsed.pathname + parsed.search : url, init);
    };
  ` }, sessionId);
  const evaluate = async expression => {
    const value = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition timed out: ${expression}; ${await evaluate("document.querySelector('#status')?.textContent")}`);
  };
  for (const kind of ["local", "remote"]) {
    const url = `${origin}/examples/${kind}-api.html?authBase=${encodeURIComponent(origin + "/auth/")}`;
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitFor("!!document.querySelector('#connect') && !document.querySelector('#connect').disabled");
    if (kind === "remote") assert.equal(await evaluate("document.querySelector('#save').disabled"), true);
    await evaluate("document.querySelector('#connect').click()");
    await waitFor(kind === "local" ? "document.querySelector('#status').textContent === 'connected'" : "document.querySelector('#status').textContent === 'Loaded from remote'");
    await evaluate(`document.querySelector('#note').value = 'Example ${kind} saved'; document.querySelector('#note').dispatchEvent(new Event('input')); document.querySelector('#save').click()`);
    await waitFor(`document.querySelector('#status').textContent === '${kind === "local" ? "Saved locally" : "Saved remotely"}'`);
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitFor(`document.querySelector('#note')?.value === 'Example ${kind} saved'`);
    if (kind === "remote") {
      await waitFor("!document.querySelector('#save').disabled");
      const row = [...objects.values()].find(row => row.bucketId === "remote-api.example.com");
      assert.ok(row);
      const advanced = await evaluate(`(async () => {
        const sdk = await import('/dist/index.js');
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('myfield-remote-api-example');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const record = await new Promise((resolve, reject) => {
          const request = database.transaction('example').objectStore('example').get('note');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        database.close();
        const { encodeNoteVersion } = await import('/examples/note-codec.js');
        const version = await encodeNoteVersion({ objectId: record.objectId,
          parentVersionIds: [${JSON.stringify(row.meta.versionId)}],
          data: new TextEncoder().encode('Example remote saved') }, record.grant);
        return { meta: version.meta, payload: Array.from(version.payload) };
      })()`);
      row.meta = advanced.meta; row.payload = Buffer.from(advanced.payload);
      const before = commits;
      await evaluate("document.querySelector('#save').click()");
      await waitFor("document.querySelector('#status').textContent.includes('Remote note changed')");
      assert.equal(commits, before);
      failRequests = true;
      await cdp.send("Page.navigate", { url }, sessionId);
      await waitFor("!!document.querySelector('#connect') && !document.querySelector('#connect').disabled");
      assert.equal(await evaluate("document.querySelector('#save').disabled"), true);
      failRequests = false;
      await cdp.send("Page.navigate", { url }, sessionId);
      await waitFor("document.querySelector('#note')?.value === 'Example remote saved'");
      await waitFor("!document.querySelector('#save').disabled");
      await evaluate("document.querySelector('#note').value = ''; document.querySelector('#note').dispatchEvent(new Event('input')); document.querySelector('#save').click()");
      await waitFor("document.querySelector('#status').textContent === 'Saved remotely'");
      assert.ok(row.payload.byteLength > 0); assert.ok(row.meta.payloadHash);
      await cdp.send("Page.navigate", { url }, sessionId);
      await waitFor("document.querySelector('#status')?.textContent === 'Loaded from remote'");
      assert.equal(await evaluate("document.querySelector('#note').value"), "");
      assert.ok(objects.has(`${row.bucketId}:${row.meta.objectId}`));
      const beforeRefresh = sessionRequests;
      credentialLifetimeMs = 14400_000;
      await evaluate("window.originalNow = Date.now; Date.now = () => window.originalNow() + 7200_000");
      await evaluate("document.querySelector('#note').value = 'Refreshed session'; document.querySelector('#note').dispatchEvent(new Event('input')); document.querySelector('#save').click()");
      await waitFor("document.querySelector('#status').textContent === 'Saved remotely'");
      assert.equal(sessionRequests, beforeRefresh + 1);
      await evaluate("Date.now = window.originalNow");
      dropNextAck = true;
      const beforeUncertain = commits;
      await evaluate("document.querySelector('#note').value = 'Uncertain save'; document.querySelector('#note').dispatchEvent(new Event('input')); document.querySelector('#save').click()");
      await waitFor("document.querySelector('#status').textContent.includes('Save paused')");
      assert.equal(commits, beforeUncertain + 1);
      assert.equal(await evaluate("document.querySelector('#save').disabled && document.querySelector('#connect').disabled"), true);
      assert.equal(await evaluate("document.querySelector('#note').value"), "Uncertain save");
      await cdp.send("Page.navigate", { url }, sessionId);
      await waitFor("document.querySelector('#note')?.value === 'Uncertain save'");
    }
    console.log(`PASS actual ${kind}-api.html: Connect, Save and reload${kind === "remote" ? ", granted key persistence, session refresh, CAS rejection, lost ACK pause and content clearing" : ""}`);
  }
} finally {
  cdp?.close(); browser.kill("SIGTERM");
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function page({ createInstance }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("sdk-browser-auth", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("auth");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  let requests = 0;
  window.fetch = async (url, init) => {
    requests++;
    if (String(url).includes("/instance-challenge")) return Response.json({ ok: true, challengeId: "challenge", challenge: "browser-proof", expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (String(url).includes("/instance-session")) {
      const { mfid, instanceId, resourceId, proof } = JSON.parse(init.body);
      check(proof.type === "instance.es256" && proof.signature, "SDK signs native browser proof");
      return Response.json({ ok: true, mfid, instanceId, resourceId, capabilities: ["read", "write"], credential: { carrier: "bearer", token: "browser-token", expiresAt: new Date(Date.now() + 7200_000).toISOString() } });
    }
    return Response.json({ versionId: null, headVersionMeta: null });
  };
  const settings = { storage: "memory", authBase: location.origin + "/auth/", authStorage: { database, store: "auth" } };
  const instance = createInstance("browser.sdk", settings); const bucket = instance.createBucket();
  const phase = new URL(location).searchParams.get("phase");
  try {
    if (phase === "1") {
      await new Promise((resolve, reject) => {
        document.querySelector("#connect").onclick = () => instance.connect({ autoSync: false }).then(resolve, reject);
        document.querySelector("#connect").click();
      });
    }
    const token = await instance.getSession({ forceRefresh: phase === "2" });
    check(token.token === "browser-token", "restored authorization gives session");
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction("auth").objectStore("auth").getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = records.find(value => value.signingPrivateKey);
    check(key?.signingPrivateKey instanceof CryptoKey && !key.signingPrivateKey.extractable, "signing key remains non-extractable");
    check(key?.wrappingPrivateKey instanceof CryptoKey && !key.wrappingPrivateKey.extractable, "wrapping key remains non-extractable");
    if (phase === "1") localStorage.setItem("testInstanceId", key.instanceId);
    else check(localStorage.getItem("testInstanceId") === key.instanceId, "reload reuses identity");
    window.fetch = async () => { throw new TypeError("offline"); };
    await bucket.put("one", { title: "Offline" });
    check((await bucket.get("one")).title === "Offline", "local CRUD stays offline");
    window.result = { phase, instanceId: key.instanceId, requests, nonExtractable: true, offlineCrud: true };
  } finally { bucket.dispose(); database.close(); }
}


async function redirectPage({ createInstance, createInstanceKey }) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("sdk-browser-redirect", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("auth");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const callback = new URL(location.href).searchParams.has("mf_request_id");
  const identity = callback ? undefined : await createInstanceKey();
  const instance = createInstance("redirect.example.com", { instanceKey: identity, authBase: location.origin + "/auth/", authStorage: { database, store: "auth" } });
  addEventListener("pagehide", () => { instance.dispose(); database.close(); });
  if (callback) {
    const grant = await instance.remote.auth.handleCallback();
    const expected = await new Promise((resolve, reject) => {
      const request = database.transaction("auth").objectStore("auth").get("expected");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    window.result = { originalIdentity: grant.instanceId === expected && instance.instanceKey.instanceId === expected,
      unbound: instance.remote.authorization === null, cleanUrl: !location.search && !location.hash };
    if (!window.result.cleanUrl) throw new Error("callback URL was not cleaned");
  } else {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("auth", "readwrite"); transaction.objectStore("auth").put(identity.instanceId, "expected");
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    });
    await instance.remote.auth.authorize({ mode: "redirect" });
  }
}
