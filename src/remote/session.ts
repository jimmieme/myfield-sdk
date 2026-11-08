import { createHttp, invalidResponse, readJson, record, requireString, string, type ApiOptions, type RequestOptions } from "./http.ts";

import { ClientError } from "../errors.ts";
import { signInstanceChallenge, type InstanceKey } from "../crypto/instance.ts";
import { throwIfAborted } from "./http.ts";

/** Connection and signing identity for session creation. @public */
export type SessionClientOptions = ApiOptions & {
  instanceKey: Pick<InstanceKey, "instanceId" | "signingPrivateKey">;
};
/** Authorized resource to exchange for a session. @public */
export type InstanceSessionInput = { mfid: string; resourceId: string };
/**
 * A bearer credential and its server-provided expiration.
 * @public
 */
export type BearerCredential = { carrier: "bearer"; token: string; expiresAt: string; sessionKind?: "instance" };
/**
 * Authorized resource capabilities and the bearer credential.
 * @public
 */
export type InstanceSession = {
  ok: true;
  mfid: string;
  instanceId: string;
  resourceId: string;
  capabilities: string[];
  credential: BearerCredential;
  [field: string]: unknown;
};

/** Creates sessions using a bound identity; no storage, refresh or retry. @public */
export interface SessionClient {
  /** Requests a challenge, signs it and exchanges the proof for a bearer session. */
  createSession(input: InstanceSessionInput, options?: RequestOptions): Promise<InstanceSession>;
}

/** Creates a session client with fixed instance keys and service origin. @public */
export function createSessionClient(options: SessionClientOptions): SessionClient {
  const request = createHttp(options);
  const instanceId = options.instanceKey?.instanceId;
  const signingPrivateKey = options.instanceKey?.signingPrivateKey;
  requireString(instanceId, "instanceId");
  if (!(signingPrivateKey instanceof CryptoKey) || signingPrivateKey.type !== "private"
    || signingPrivateKey.algorithm.name !== "ECDSA" || (signingPrivateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
    || !signingPrivateKey.usages.includes("sign")) {
    throw new ClientError("INVALID_INPUT", "An instance signing key is required");
  }
  async function post(route: string, body: unknown, options: RequestOptions) {
    const response = await request(`/v1/api/auth/${route}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: options.signal,
    });
    const payload = await readJson(response, options.signal);
    throwIfAborted(options.signal);
    return { response, body: payload };
  }
  return {
    async createSession(input, options = {}): Promise<InstanceSession> {
      requireString(input?.mfid, "mfid"); requireString(input?.resourceId, "resourceId");
      const identity = { mfid: input.mfid, resourceId: input.resourceId, instanceId };
      const challenge = await post("instance-challenge", identity, options);
      if (challenge.body.ok !== true || !string(challenge.body.challengeId)
        || !string(challenge.body.challenge) || !string(challenge.body.expiresAt)) throw invalidResponse(challenge.response);
      throwIfAborted(options.signal);
      let proof;
      try {
        proof = await signInstanceChallenge({ instance: { instanceId, signingPrivateKey }, ...identity,
          challengeId: challenge.body.challengeId, challenge: challenge.body.challenge });
      } catch (cause) { throw new ClientError("SIGNING_FAILED", "Could not sign the instance challenge", { cause }); }
      throwIfAborted(options.signal);
      const { response, body } = await post("instance-session", {
        ...identity, challengeId: challenge.body.challengeId, proof, credentialCarrier: "bearer",
      }, options);
      if (body.ok !== true || body.mfid !== identity.mfid || body.instanceId !== instanceId
        || body.resourceId !== identity.resourceId || !Array.isArray(body.capabilities)
        || !body.capabilities.every(string) || !record(body.credential)
        || body.credential.carrier !== "bearer" || !string(body.credential.token) || !string(body.credential.expiresAt)) throw invalidResponse(response);
      return body as InstanceSession;
    },
  };
}
