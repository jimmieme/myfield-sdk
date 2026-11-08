import { bytesToB64url, normalizeIsoDateTime, sha256Hex, stableStringify, utf8Encode } from "../internal/encoding.ts";
type InstanceProof = { type: "instance.es256"; instanceId: string; alg: "ES256"; signedAt: string; signature: string };

/** Instance identity and non-extractable key handles. @public */
export type InstanceKey = {
  v: 1;
  instanceId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  wrappingPublicJwk: JsonWebKey;
  wrappingPrivateKey: CryptoKey;
  createdAt: string;
};

/** Creates non-extractable instance keys without storage or network access. @public */
export async function createInstanceKey(): Promise<InstanceKey> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const wrapping = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const signingPublicJwk = (await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey;
  const wrappingPublicJwk = (await crypto.subtle.exportKey("jwk", wrapping.publicKey)) as JsonWebKey;
  return {
    v: 1,
    instanceId: await deriveInstanceId(signingPublicJwk),
    signingPublicJwk,
    signingPrivateKey: signing.privateKey,
    wrappingPublicJwk,
    wrappingPrivateKey: wrapping.privateKey,
    createdAt: new Date().toISOString(),
  };
}

export async function deriveInstanceId(signingPublicJwk: JsonWebKey): Promise<string> {
  const digest = await sha256Hex(stableStringify(jwkCore(signingPublicJwk)));
  return `inst_${digest.slice(0, 32)}`;
}

/** Signs the fixed instance authentication challenge. */
export async function signInstanceChallenge(input: {
  instance: Pick<InstanceKey, "instanceId" | "signingPrivateKey">;
  challenge: string;
  mfid: string;
  resourceId: string;
  challengeId?: string;
  signedAt?: string;
}): Promise<InstanceProof> {
  const signedAt = normalizeIsoDateTime(input.signedAt) || new Date().toISOString();
  const payload = stableStringify({
    v: 1,
    type: "instance-proof",
    instanceId: input.instance.instanceId,
    challenge: input.challenge,
    challengeId: input.challengeId || "",
    mfid: input.mfid,
    resourceId: input.resourceId,
    signedAt,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.instance.signingPrivateKey, utf8Encode(payload));
  return { type: "instance.es256", instanceId: input.instance.instanceId, alg: "ES256", signedAt, signature: bytesToB64url(new Uint8Array(signature)) };
}

function jwkCore(jwk: JsonWebKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["kty", "crv", "x", "y", "kid", "alg", "use"] as const) {
    const value = (jwk as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
