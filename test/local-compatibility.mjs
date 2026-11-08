import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createInstance } from "../src/index.ts";
import { BucketTransport } from "../src/bucket/transport.ts";

let published;
async function baseline() {
  const directory = await mkdtemp(path.join(tmpdir(), "sdk-091-"));
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const archive = spawnSync("git", ["archive", "v0.9.1"], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    assert.equal(archive.status, 0, "Fetch the v0.9.1 tag before running compatibility verification");
    const unpack = spawnSync("tar", ["-x", "-C", directory], { input: archive.stdout });
    assert.equal(unpack.status, 0, String(unpack.stderr));
    assert.equal(JSON.parse(await readFile(path.join(directory, "package.json"))).version, "0.9.1");
    const result = await build({ stdin: { contents: 'export { createInstance } from "./src/index.ts"; export { BucketTransport } from "./src/bucket/transport.ts";', resolveDir: directory },
      bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function verifyLocalCompatibility({ apiBase, mfid, keys, fetch }) {
  published ??= baseline();
  const old = await published, previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12), id = crypto.randomUUID();
  const first = old.createInstance({ namespace: `old${suffix}`, storage: "memory" });
  const second = createInstance({ namespace: `new${suffix}`, storage: "memory" });
  const left = first.createBucket({ id: keys.bucketId }), right = second.createBucket({ id: keys.bucketId });
  const settings = { apiBase, mfid, keys, sessionProvider: { getSession: async () => ({ carrier: "bearer", token: "compatibility-token" }) } };
  const errors = [];
  for (const bucket of [left, right]) bucket.on("state", (_state, detail) => { if (detail) errors.push(detail); });
  const sync = async bucket => { await bucket.sync(); assert.deepEqual(errors, []); };
  try {
    left.setAutoSync(false); right.setAutoSync(false);
    left.__bindTestTransport(new old.BucketTransport(settings));
    right.__bindTestTransport(new BucketTransport(settings));
    await left.put(id, { title: "old client", body: "initial", removed: "field" });
    await sync(left); await sync(right);
    assert.deepEqual(await right.get(id), { title: "old client", body: "initial", removed: "field" });
    await left.update(id, { title: "old edit" });
    await right.update(id, { body: "new edit", removed: undefined });
    await sync(right); await sync(left); await sync(right);
    assert.deepEqual(await left.get(id), { title: "old edit", body: "new edit" });
    assert.deepEqual(await right.get(id), await left.get(id));
    await right.delete(id); await sync(right); await sync(left);
    assert.equal(await left.get(id), null); assert.equal(await right.get(id), null);
    console.log("PASS v0.9.1 and current Local: bidirectional ciphertext, concurrent field merge and encrypted deletion");
    return id;
  } finally { left.dispose(); second.dispose(); globalThis.fetch = previousFetch; }
}

async function verifyMock() {
  const records = new Map(), mfid = "ab".repeat(16), bucketId = "compat.example.com";
  const payloadKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const fetch = async (input, init = {}) => {
    const url = new URL(input), parts = url.pathname.split("/"), objectId = decodeURIComponent(parts[parts.indexOf("objects") + 1]);
    if (init.method === "POST") {
      const form = init.body, meta = JSON.parse(form.get("versionMeta")), expected = form.get("expectedHeadVersionId");
      if (expected !== (records.get(objectId)?.meta.versionId ?? null)) return Response.json({ ok: false, reason: "version-mismatch" });
      const payload = new Uint8Array(await form.get("versionPayload").arrayBuffer()), envelope = JSON.parse(new TextDecoder().decode(payload));
      assert.equal(envelope.cipherMeta.aad, `myfield.bucket.sync.v1|${bucketId}|${objectId}`);
      assert.equal(envelope.wrappedDEKMeta.alg, "direct-bucket-key");
      assert.deepEqual(JSON.parse(form.get("headState")).fieldSources, {});
      records.set(objectId, { meta, payload }); return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("objects:index")) return Response.json({ bucketId, objects: [...records.entries()].map(([objectId, { meta }]) => ({ objectId, versionId: meta.versionId })), feedCursor: "0", hasMoreFeed: false });
    if (url.pathname.endsWith("/feed")) return Response.json({ entries: [], cursor: "0", hasMore: false });
    if (url.pathname.endsWith("/current")) return Response.json({ versionId: records.get(objectId)?.meta.versionId ?? null, headVersionMeta: records.get(objectId)?.meta ?? null });
    if (url.pathname.endsWith("/payload")) return new Response(records.get(objectId).payload);
    throw new Error(`Unexpected compatibility route: ${url.pathname}`);
  };
  await verifyLocalCompatibility({ apiBase: "https://api.example.test", mfid, keys: { bucketId, keyId: "bk_compat", payloadKey, wireObjectId: async id => id }, fetch });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifyMock();
