import assert from "node:assert/strict";
import test from "node:test";
import { encodeNoteVersion, decodeNoteVersion } from "../examples/note-codec.js";
import { encryptEnvelopeFields, decryptEnvelope } from "../src/bucket/crypto.ts";

async function grant() {
  return { bucketId: "notes.example.com", keyId: "bk_example", payloadKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
}
const data = new TextEncoder().encode("Private note");

test("the example codec uses the existing direct-bucket-key envelope in both directions", async () => {
  const access = await grant(), keys = { ...access, wireObjectId: async id => id };
  const version = await encodeNoteVersion({ objectId: "opaque", parentVersionIds: [], data }, access);
  assert.deepEqual(await decryptEnvelope(keys, "opaque", version.payload), data);
  assert.deepEqual(await decodeNoteVersion({ ...version, payload: new Response(version.payload) }, access), data);
  assert.equal(version.meta.payloadHash, `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", version.payload)).toString("base64url")}`);
  assert.equal(new TextDecoder().decode(version.payload).includes("Private note"), false);
  const meta = { objectId: "opaque", versionId: "old", parentVersionIds: [], kind: "create" };
  const payload = new TextEncoder().encode(JSON.stringify({ ...meta, ...await encryptEnvelopeFields(keys, "opaque", data) }));
  assert.deepEqual(await decodeNoteVersion({ meta, payload }, access), data);
});

test("the example rejects altered hashes, identities, key references and authentication", async () => {
  const access = await grant();
  const version = await encodeNoteVersion({ objectId: "opaque", parentVersionIds: [], data }, access);
  await assert.rejects(decodeNoteVersion({ ...version, meta: { ...version.meta, payloadHash: "wrong" } }, access));
  await assert.rejects(decodeNoteVersion({ ...version, meta: { ...version.meta, versionId: "wrong" } }, access));
  await assert.rejects(decodeNoteVersion(version, { ...access, bucketId: "wrong" }));
  await assert.rejects(decodeNoteVersion(version, { ...access, keyId: "wrong" }));
  await assert.rejects(decodeNoteVersion(version, { ...access, payloadKey: (await grant()).payloadKey }));
  const envelope = JSON.parse(new TextDecoder().decode(version.payload));
  envelope.ciphertext = "A".repeat(envelope.ciphertext.length);
  const payload = new TextEncoder().encode(JSON.stringify(envelope));
  await assert.rejects(decodeNoteVersion({ meta: { ...version.meta, payloadHash: undefined }, payload }, access));
});

test("saving an empty note still produces authenticated ciphertext", async () => {
  const access = await grant();
  const version = await encodeNoteVersion({ objectId: "opaque", parentVersionIds: ["previous"], data: new Uint8Array() }, access);
  assert.ok(version.payload.length > 0);
  assert.equal((await decodeNoteVersion(version, access)).length, 0);
  await assert.rejects(decodeNoteVersion({ meta: { ...version.meta, payloadHash: undefined }, payload: new Uint8Array() }, access));
});
