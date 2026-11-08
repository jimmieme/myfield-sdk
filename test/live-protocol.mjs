import { verifyLocalCompatibility } from "./local-compatibility.mjs";
import { encodeNoteVersion, decodeNoteVersion } from "../examples/note-codec.js";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { BucketTransport } from "../src/bucket/transport.ts";
import { unwrapBucketKeys } from "../src/bucket/keys.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBucketRemote, createSessionClient, createInstanceKey, createInstance } from "../src/index.ts";

assert.ok(process.argv[2], "Usage: npm run test:live -- /path/to/myfield");
const root = path.resolve(process.argv[2]);
const load = relative => import(pathToFileURL(path.join(root, relative)));
const { buildDidDocumentProofRequest, createDidDocumentDraft, createDidDocumentFromProof } = await load("packages/did/src/index.ts");
const { buildOwnerJwkProofPayload, createBucketGrantPayloads, createKeychain, signAuthRecord,
  signKeychainArtifact } = await load("packages/auth/src/core.ts");
const apiBase = process.env.API_BASE || "https://api-dev.myfield.space";
const authBase = process.env.AUTH_BASE || "https://dev.myfield.space";
const origin = authBase;
const bucketId = "protocol-sdk.myfield";
const objectId = `protocol/${crypto.randomUUID()}`;
const encoder = new TextEncoder();
const randomHex = bytes => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const bytesToB64url = bytes => Buffer.from(bytes).toString("base64url");
const logOk = message => console.log(`PASS ${message}`);
let ownerCookie = "";
const nativeFetch = globalThis.fetch;
const fetchWithOrigin = (url, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  return nativeFetch(url, { ...init, headers });
};
async function postJson(route, body) {
  const response = await fetchWithOrigin(`${authBase}${route}`, { method: "POST",
    headers: { "content-type": "application/json", ...(ownerCookie ? { cookie: ownerCookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true, `${route}: ${response.status} ${response.ok ? "" : await response.text()}`);
  const cookie = response.headers.get("set-cookie")?.match(/mf_owner_session=([^;,\s]+)/);
  if (cookie) ownerCookie = `mf_owner_session=${cookie[1]}`;
  return response.json();
}

async function createOwner() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const ownerPublicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const draft = await createDidDocumentDraft({ ownerPublicJwk });
  const request = await buildDidDocumentProofRequest(draft.unsignedDocument);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    encoder.encode(request.challengeHash)
  );
  const did = await createDidDocumentFromProof({
    unsignedDocument: draft.unsignedDocument,
    ownerMethodId: draft.ownerMethodId,
    proof: {
      type: "jwk.sign",
      verificationMethod: draft.ownerMethodId,
      signature,
    },
  });
  return { ...did, ownerPrivateKey: pair.privateKey };
}

async function buildOwnerProof(owner, instanceId = "auth-profile") {
  const challenge = await postJson("/v1/api/auth/challenge", { mfid: owner.mfid, authn: "owner-key-proof" });
  const payload = buildOwnerJwkProofPayload({
    challenge: challenge.challenge,
    spaceId: owner.mfid,
    instanceId,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      owner.ownerPrivateKey,
      encoder.encode(payload)
    )
  );
  return {
    type: "jwk.sign",
    verificationMethod: owner.ownerMethodId,
    challenge: challenge.challenge,
    spaceId: owner.mfid,
    instanceId,
    alg: "ES256",
    signature: bytesToB64url(signature),
    createdAt: new Date().toISOString(),
  };
}

const owner = await createOwner();
const instance = await createInstanceKey();
const profileResult = await postJson("/v1/api/auth/profile", {
  mfid: owner.mfid,
  didDocument: owner.document,
  didProofChain: owner.proofChain,
  ownerProof: await buildOwnerProof(owner),
});
assert.equal(profileResult.ok, true);
assert.equal(profileResult.profile?.mfid, owner.mfid);
assert.ok(ownerCookie, "profile registration must set owner session cookie");
logOk("auth profile registered");

const issuedAt = new Date().toISOString();
const keyId = `bk_${randomHex(16)}`;
const keychain = await createKeychain({
  mfid: owner.mfid,
  didDocumentVersion: owner.document.version ?? 1,
  createdAt: issuedAt,
});
const {
  bucketOwnerEnvelopeArtifact: ownerEnvelopeArtifact,
  envelope: grantBucketEnvelope,
} = await createBucketGrantPayloads({
  mfid: owner.mfid,
  keyId,
  bucketId,
  rootKeyId: keychain.rootKeyId,
  rootKey: keychain.rootKey,
  targetInstanceId: instance.instanceId,
  targetWrappingPublicJwk: instance.wrappingPublicJwk,
  createdAt: issuedAt,
});
const grant = await signAuthRecord({
  recordType: "auth.grant.v1",
  mfid: owner.mfid,
  did: owner.did,
  issuedAt,
  ownerMethodId: owner.ownerMethodId,
  ownerPrivateKey: owner.ownerPrivateKey,
  payload: {
    requestId: `req_verify_${randomHex(8)}`,
    origin,
    instanceId: instance.instanceId,
    instanceSigningPublicJwk: instance.signingPublicJwk,
    instanceWrappingPublicJwk: instance.wrappingPublicJwk,
    resourceId: `urn:myfield:bucket:${bucketId}`,
    keyId,
    capabilities: ["read", "write"],
    envelope: grantBucketEnvelope,
  },
});
assert.match(grant.recordId, /^ar_[a-f0-9]{32}$/);
const rootRecoveryArtifact = await signKeychainArtifact({
  artifact: keychain.artifact,
  ownerMethodId: owner.ownerMethodId,
  ownerPrivateKey: owner.ownerPrivateKey,
});
const push = await postJson("/v1/api/auth/records/push", {
  mfid: owner.mfid,
  records: [grant],
});
assert.equal(push.ok, true);
assert.deepEqual(push.rejected, [], JSON.stringify(push));
logOk("signed auth grant record pushed and verified");

const envelopePush = await postJson("/v1/api/auth/envelopes/put", {
  mfid: owner.mfid,
  envelopes: [rootRecoveryArtifact, ownerEnvelopeArtifact],
});
assert.equal(envelopePush.ok, true);
assert.deepEqual(envelopePush.rejected, [], JSON.stringify(envelopePush));
logOk("bucket key envelope artifacts pushed");

const identity = { mfid: owner.mfid, resourceId: `urn:myfield:bucket:${bucketId}`, instanceId: instance.instanceId };
const sessions = createSessionClient({ apiBase, fetch: fetchWithOrigin, instanceKey: instance });
const session = await sessions.createSession(identity, { signal: AbortSignal.timeout(30000) });
assert.equal(session.credential.carrier, "bearer");
logOk("SDK challenge and session against deployed Auth");
const database = await new Promise((resolve, reject) => {
  const request = indexedDB.open(`sdk-live-${crypto.randomUUID()}`, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("auth");
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const prefix = `instance-scope:${encodeURIComponent(bucketId)}:instance:${encodeURIComponent(bucketId)}:`;
await new Promise((resolve, reject) => {
  const transaction = database.transaction("auth", "readwrite"); const store = transaction.objectStore("auth");
  store.put({ ...instance, updatedAt: issuedAt }, `${prefix}instance-key:${instance.instanceId}`);
  store.put({ v: 1, instanceId: instance.instanceId, updatedAt: issuedAt }, `${prefix}active-instance:current`);
  store.put({ v: 1, ...identity, requestId: "live-restore", authorizedAt: issuedAt, resourceApiUrl: apiBase,
    bucketAccessGrant: { v: 1, ...identity, grantRecordId: grant.recordId, issuedAt, keyId,
      capabilities: ["read", "write"], envelope: grantBucketEnvelope } },
    `${prefix}context:${encodeURIComponent(identity.resourceId)}:${instance.instanceId}`);
  transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
});
let credential;
globalThis.fetch = fetchWithOrigin;
try {
  const settings = { storage: "memory", authStorage: { database, store: "auth" } };
  credential = await createInstance(bucketId, settings).getSession();
  assert.equal(credential.carrier, "bearer");
  assert.equal((await createInstance(bucketId, settings).getSession()).token, credential.token);
  logOk("public instance.getSession restores identity and refreshes through SDK Remote");
  const keys = await unwrapBucketKeys(grantBucketEnvelope, instance.wrappingPrivateKey);
  await verifyLocalCompatibility({ apiBase, mfid: owner.mfid, keys,
    fetch: (url, init = {}) => {
      const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${credential.token}`);
      return fetchWithOrigin(url, { ...init, headers });
    } });
  const legacy = new BucketTransport({ apiBase, mfid: owner.mfid, keys,
    sessionProvider: { getSession: async () => credential } });
  const wireId = await keys.wireObjectId(`legacy/${crypto.randomUUID()}`);
  const plaintext = encoder.encode('{"synthetic":true}');
  const committed = await legacy.push(wireId, plaintext, null);
  assert.equal(committed.ok, true);
  assert.deepEqual((await legacy.pullCurrent(wireId)).plaintext, plaintext);
  const cleanup = createBucketRemote({ apiBase, mfid: owner.mfid, bucketId, fetch: fetchWithOrigin, getCredential: () => credential });
  const codec = { bucketId, keyId, payloadKey: keys.payloadKey };
  const cleared = await encodeNoteVersion({ objectId: wireId, parentVersionIds: [committed.versionId], data: new Uint8Array() }, codec);
  assert.deepEqual(await cleanup.commit({ ...cleared, expectedHeadVersionId: committed.versionId }), { ok: true });
  assert.equal((await decodeNoteVersion(await cleanup.getVersion(wireId, cleared.meta.versionId), codec)).length, 0);
  logOk("Local legacy encryption/transport roundtrip through SDK Remote and deployed Worker; content cleared");
} finally { globalThis.fetch = nativeFetch; database.close(); }
const remoteInstance = createInstance(bucketId, { instanceKey: instance, fetch: fetchWithOrigin });
const directKeys = await unwrapBucketKeys(grantBucketEnvelope, instance.wrappingPrivateKey);
remoteInstance.remote.bind({ ...identity, bucketId, apiBase, keyId, payloadKey: directKeys.payloadKey, capabilities: ["read", "write"] });
const remote = remoteInstance.remote.bucket;
assert.equal(await remote.getCurrent(objectId, { have: "missing" }), null);
const initialIndex = await remote.getIndex();
await remote.listFeed({ cursor: initialIndex.feedCursor });
const controller = new AbortController();
const events = remote.watchFeed({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
try {
  assert.deepEqual(await events.next(), { done: false, value: { type: "ready" } });
  await remote.listFeed({ cursor: initialIndex.feedCursor });
  logOk("SSE ready before feed catch-up");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const codec = { bucketId, keyId, payloadKey: key };
  const plaintext = encoder.encode("Protocol client verification");
  const first = await encodeNoteVersion({ objectId, parentVersionIds: [], data: plaintext }, codec);
  const { payload } = first;
  const meta = { ...first.meta, extension: { kept: true } };
  const change = async versionId => assert.deepEqual(await events.next(), {
    done: false, value: { type: "change", objectId, versionId },
  });
  assert.deepEqual(await remote.commit({ meta, payload, expectedHeadVersionId: null }), { ok: true });
  await change(meta.versionId);
  assert.deepEqual(new Uint8Array(await (await remote.getPayload(objectId, meta.versionId)).arrayBuffer()), payload);
  assert.deepEqual(await remote.getVersionMeta(objectId, meta.versionId), meta);
  const downloaded = await remote.getVersion(objectId, meta.versionId);
  assert.deepEqual(downloaded.meta, meta);
  assert.deepEqual(await decodeNoteVersion(downloaded, codec), plaintext);
  const next = await encodeNoteVersion({ objectId, parentVersionIds: [meta.versionId], data: plaintext }, codec);
  const updated = next.meta;
  assert.deepEqual(await remote.commit({ meta: updated, payload: next.payload, expectedHeadVersionId: meta.versionId }), { ok: true });
  await change(updated.versionId);
  const stale = { ...meta, versionId: "stale", parentVersionIds: [meta.versionId] };
  assert.deepEqual(await remote.commit({ meta: stale, payload, expectedHeadVersionId: meta.versionId }), { ok: false, reason: "version-mismatch" });
  logOk("R2 payload, metadata, update and CAS rejection");
  assert.deepEqual((await remote.getCurrent(objectId, { have: meta.versionId })).history, [updated.versionId, meta.versionId]);
  assert.deepEqual((await remote.getCurrent(objectId, { have: "missing" })).history, []);
  const history = await remote.listVersionHistory(objectId, updated.versionId, { limit: 1 });
  assert.deepEqual(history.history, [updated.versionId]);
  assert.deepEqual((await remote.listVersionHistory(objectId, updated.versionId, { cursor: history.nextCursor })).history, [meta.versionId]);
  const cleared = await encodeNoteVersion({ objectId, parentVersionIds: [updated.versionId], data: new Uint8Array() }, codec);
  assert.deepEqual(await remote.commit({ ...cleared, expectedHeadVersionId: updated.versionId }), { ok: true });
  await change(cleared.meta.versionId);
  const current = await remote.getCurrent(objectId);
  assert.ok(current); assert.deepEqual(current.headVersionMeta, cleared.meta);
  const empty = await remote.getVersion(objectId, cleared.meta.versionId);
  assert.equal((await decodeNoteVersion(empty, codec)).length, 0);
  assert.ok((await (await remote.getPayload(objectId, cleared.meta.versionId)).arrayBuffer()).byteLength > 0);
  const feed = await remote.listFeed({ cursor: null });
  assert.deepEqual(feed.entries.filter(entry => entry.objectId === objectId).map(entry => entry.versionId), [meta.versionId, updated.versionId, cleared.meta.versionId]);
  logOk("history, authenticated content clearing with retained object, durable feed and projected SSE hints");
} finally {
  controller.abort();
  await events.return();
  remoteInstance.dispose();
}
console.log("PASS deployed Auth/Worker/R2 protocol verification with Remote-managed sessions");
