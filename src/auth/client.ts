import { ClientError } from "../errors.ts";
import type { InstanceKey } from "../crypto/instance.ts";
import { randomId } from "../internal/encoding.ts";
import { authorizationContext } from "./context.ts";
import { createAuthorizationFlow, openAuthorizationPopup } from "./flow.ts";
import { buildAuthRequestFragment, bucketResourceId, isValidBucketId, readAuthorizationResult } from "./instance.ts";

/** Cloneable authorization context and a non-extractable bucket data key. @public */
export type AuthorizationContext = {
  mfid: string;
  instanceId: string;
  bucketId: string;
  resourceId: string;
  apiBase: string;
  keyId: string;
  payloadKey: CryptoKey;
  capabilities: ("read" | "write")[];
};

/** Pending authorization state; persist alongside the identity before a same-tab redirect. @public */
export type AuthorizationRequest = {
  url: string;
  requestId: string;
  state: string;
  resourceId: string;
  instanceId: string;
  redirectUri: string;
  createdAt: string;
};

/** Instance identity and authorization page; no storage or session creation. @public */
export type AuthorizationClientOptions = {
  appId: string;
  instanceKey: InstanceKey;
  authBase?: string;
  redirectUri?: string;
};

/** Authorization flow independent of durable storage and bucket HTTP operations. @public */
export interface AuthorizationClient {
  /** Builds a same-tab request without navigating or persisting anything. */
  createRequest(options?: { bucketId?: string }): AuthorizationRequest;
  /** Validates/decrypts a callback against retained request state; performs no writes. */
  handleCallback(url: string, request: AuthorizationRequest): Promise<AuthorizationContext>;
  /** Opens a popup from a user action and returns the verified context/key; never persists it. */
  authorize(options?: { bucketId?: string; signal?: AbortSignal }): Promise<AuthorizationContext>;
}

/** Binds an existing identity to authorization requests and callback processing. @public */
export function createAuthorizationClient(options: AuthorizationClientOptions): AuthorizationClient {
  const { appId, instanceKey } = options ?? {};
  if (!isValidBucketId(appId) || appId !== appId.trim() || !instanceKey
    || !/^inst_[a-f0-9]{32}$/.test(instanceKey.instanceId)
    || !(instanceKey.wrappingPrivateKey instanceof CryptoKey) || instanceKey.wrappingPrivateKey.extractable
    || instanceKey.wrappingPrivateKey.algorithm.name !== "ECDH"
    || (instanceKey.wrappingPrivateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
    || !instanceKey.wrappingPrivateKey.usages.includes("deriveBits")) {
    throw new ClientError("INVALID_INPUT", "An appId and non-extractable instance wrapping key are required");
  }
  let authPage: URL;
  try {
    authPage = new URL(options.authBase ?? "https://myfield.one/auth/");
    if (!["https:", "http:"].includes(authPage.protocol) || authPage.username || authPage.password || authPage.hash) throw new Error();
  } catch (cause) { throw new ClientError("INVALID_INPUT", "Invalid authorization page URL", { cause }); }

  function createRequest(input: { bucketId?: string } = {}): AuthorizationRequest {
    if (!input || typeof input !== "object") throw new ClientError("INVALID_INPUT", "Authorization options must be an object");
    const bucketId = input.bucketId ?? appId;
    if (!isValidBucketId(bucketId) || bucketId !== bucketId.trim()) throw new ClientError("INVALID_INPUT", "Invalid bucketId");
    try {
      const redirect = new URL(options.redirectUri ?? (typeof window !== "undefined" ? window.location.origin + window.location.pathname : ""));
      if (!["https:", "http:"].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash) throw new Error("Invalid redirectUri");
      const request = { requestId: randomId("req"), state: randomId("state"), resourceId: bucketResourceId(bucketId),
        instanceId: instanceKey.instanceId, redirectUri: redirect.href, createdAt: new Date().toISOString() };
      const fragment = buildAuthRequestFragment({ ...request, clientId: appId, origin: redirect.origin,
        capabilities: ["read", "write"], instanceSigningPublicJwk: instanceKey.signingPublicJwk,
        instanceWrappingPublicJwk: instanceKey.wrappingPublicJwk });
      const url = new URL(authPage); url.searchParams.set("callbackTransport", "same-tab"); url.hash = fragment;
      return { ...request, url: url.href };
    } catch (cause) { throw new ClientError("INVALID_INPUT", "Invalid authorization request", { cause }); }
  }

  async function handleCallback(url: string, request: AuthorizationRequest): Promise<AuthorizationContext> {
    if (!request || request.instanceId !== instanceKey.instanceId || !request.requestId || !request.state
      || !Number.isFinite(Date.parse(request.createdAt)) || Date.now() - Date.parse(request.createdAt) > 600_000
      || Date.parse(request.createdAt) > Date.now() + 60_000) {
      throw new ClientError("INVALID_AUTHORIZATION", "Authorization request is missing, expired or belongs to another identity");
    }
    try {
      const callback = new URL(url); const redirect = new URL(request.redirectUri);
      if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) throw new Error("Callback destination mismatch");
      const result = await readAuthorizationResult(callback, request, instanceKey.wrappingPrivateKey);
      return await authorizationContext(result, instanceKey);
    } catch (cause) {
      if (cause instanceof ClientError) throw cause;
      throw new ClientError("INVALID_AUTHORIZATION", "Could not validate or decrypt authorization", { cause });
    }
  }

  const flow = createAuthorizationFlow();
  function authorize(input: { bucketId?: string; signal?: AbortSignal } = {}): Promise<AuthorizationContext> {
    if (!input || typeof input !== "object") return Promise.reject(new ClientError("INVALID_INPUT", "Authorization options must be an object"));
    try {
      const request = createRequest(input);
      return flow.run(signal => openAuthorizationPopup({ request, signal,
        callback: (url, pending) => handleCallback(url, pending) }), input.signal);
    } catch (error) { return Promise.reject(error); }
  }
  return { createRequest, handleCallback, authorize };
}
