const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function base64url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encrypted note encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Invalid encrypted note encoding");
  return bytes;
}
const aadFor = (grant, objectId) => `myfield.bucket.sync.v1|${grant.bucketId}|${objectId}`;
const payloadHash = async bytes => `sha256:${base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;

export async function encodeNoteVersion({ objectId, parentVersionIds, data }, grant) {
  const versionId = crypto.randomUUID(), iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = aadFor(grant, objectId);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, grant.payloadKey, data);
  const payload = encoder.encode(JSON.stringify({ objectId, versionId, parentVersionIds,
    kind: parentVersionIds.length ? "update" : "create", ciphertext: base64url(new Uint8Array(encrypted)),
    cipherMeta: { alg: "AES-GCM", iv: base64url(iv), keyId: grant.keyId, bucketId: grant.bucketId, aad },
    wrappedDEK: grant.keyId, wrappedDEKMeta: { alg: "direct-bucket-key", keyId: grant.keyId, bucketId: grant.bucketId },
  }));
  return { meta: { objectId, versionId, parentVersionIds: [...parentVersionIds], payloadHash: await payloadHash(payload) }, payload };
}

export async function decodeNoteVersion({ meta, payload }, grant) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(await payload.arrayBuffer());
  if (meta.payloadHash !== undefined && meta.payloadHash !== await payloadHash(bytes)) throw new Error("Encrypted note hash mismatch");
  const body = JSON.parse(decoder.decode(bytes)), cipher = body.cipherMeta, wrap = body.wrappedDEKMeta;
  const aad = aadFor(grant, meta.objectId);
  if (body.objectId !== meta.objectId || body.versionId !== meta.versionId
    || JSON.stringify(body.parentVersionIds) !== JSON.stringify(meta.parentVersionIds)
    || cipher?.alg !== "AES-GCM" || cipher.bucketId !== grant.bucketId || cipher.keyId !== grant.keyId || cipher.aad !== aad
    || body.wrappedDEK !== grant.keyId || wrap?.alg !== "direct-bucket-key" || wrap.bucketId !== grant.bucketId || wrap.keyId !== grant.keyId) throw new Error("Invalid encrypted note envelope");
  const iv = decode(cipher.iv), ciphertext = decode(body.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted note envelope");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, grant.payloadKey, ciphertext));
}
