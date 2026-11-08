import { authorizationContext } from "./context.ts";
import type { AuthorizationContext, AuthorizationRequest } from "./client.ts";
import { createInstanceKey, deriveInstanceId, type InstanceKey } from "../crypto/instance.ts";
export { signInstanceChallenge } from "../crypto/instance.ts";
import { createSessionClient, type InstanceSession } from "../remote/session.ts";
import { ClientError } from "../errors.ts";
// Instance auth client for the open surface, ported from the notepad
// prototype and trimmed to the open contract:
//   - bucket resources only, fixed read+write capabilities
//   - SDK v1 authorization (`mf_auth_mode=v1` is always sent); the
//     app-visible mfid is a pairwise alias, never the owner mfid
//   - exactly two API routes: instance-challenge and instance-session
//     (alias mode has no grant refetch; bucket access rides on the
//     callback-provided bucketAccessGrant)
// The /auth fragment wire format is frozen as-is, including its vestigial
// OAuth-shaped fields; this module hides it from apps entirely.

import {
  b64urlToBytes,
  bytesToB64url,
  bytesToHex,
  normalizeIsoDateTime,
  randomId,
  sha256Hex,
  stableStringify,
  utf8Encode,
} from "../internal/encoding.ts";
import { unwrapBucketKeys, type BucketKeyGrantEnvelope, type BucketKeys } from "../bucket/keys.ts";
import { createIndexedDbStorageAdapter, type StorageAdapter } from "../bucket/store.ts";

export type AuthCapability = "read" | "write";

export type AuthInstance = InstanceKey;

export type InstanceAuthContext = {
  v: 1;
  mfid: string;
  resourceId: string;
  remoteResourceId?: string;
  resourceApiUrl?: string;
  instanceId: string;
  requestId: string;
  authorizedAt: string;
  bucketAccessGrant?: BucketAccessGrant;
};

export type CloudSessionCredential =
  | { carrier: "bearer"; token: string; expiresAt: string }
  | { carrier: "cookie"; expiresAt: string };

export type BucketAccess = {
  mfid: string;
  instanceId: string;
  bucketId: string;
  resourceId: string;
  resourceApiUrl?: string;
  capabilities: AuthCapability[];
  grantRecordId: string;
  keys: BucketKeys;
};

export type InstanceAuthClientOptions = {
  appId?: string;
  apiBase?: string;
  authPageUrl?: string;
  redirectUri?: string;
  origin?: string;
  openAuthUrl?: (url: string) => void | Promise<void>;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
  instanceKey?: InstanceKey;
  onIdentity?: (identity: InstanceKey) => void;
  createSession?: (apiBase: string, identity: InstanceKey, input: { mfid: string; resourceId: string }) => Promise<InstanceSession>;
};

export type AuthCallbackResult = {
  requestId: string;
  state: string;
  result: "approved" | "denied" | "error";
  resourceId?: string;
  error?: string;
  errorDescription?: string;
};

export type InstanceAuthClient = {
  ensureInstance(): Promise<AuthInstance>;
  authorize(request: { bucketId: string }): Promise<void>;
  prepareAuthorization(request: { bucketId: string }, signal?: AbortSignal): Promise<AuthorizationRequest>;
  cancelAuthorization(requestId: string): Promise<void>;
  handleCallback(url?: string, options?: { persist?: boolean; signal?: AbortSignal }): Promise<(AuthCallbackResult & { authorization?: AuthorizationContext }) | null>;
  getContext(bucketId: string): Promise<InstanceAuthContext | null>;
  getSession(bucketId: string, options?: { forceRefresh?: boolean }): Promise<CloudSessionCredential>;
  getBucketAccess(bucketId: string): Promise<BucketAccess>;
  clearContext(bucketId: string): Promise<void>;
};

export type BucketAccessGrant = {
  v: 1;
  grantRecordId: string;
  mfid: string;
  resourceId: string;
  instanceId: string;
  issuedAt: string;
  keyId: string;
  capabilities: AuthCapability[];
  envelope: BucketKeyGrantEnvelope;
};

type StoredAuthAuthorizationResult = {
  v: 1;
  requestId: string;
  state: string;
  result: "approved";
  mfid: string;
  resourceId: string;
  instanceId: string;
  createdAt: string;
  resourceApiUrl?: string;
  bucketAccessGrant?: BucketAccessGrant;
  expiresAt?: string;
};

type EncryptedAuthAuthorizationResultEnvelope = {
  v: 1;
  typ: "auth.authorization-result.envelope.v1";
  alg: "ECDH-HKDF-SHA-256/AES-GCM-256";
  requestId: string;
  state: string;
  resourceId: string;
  instanceId: string;
  ephemeralPublicJwk: JsonWebKey;
  salt: string;
  iv: string;
  aad: string;
  ciphertext: string;
};

type PendingInstanceAuthRequest = {
  redirectUri?: string;
  v: 1;
  requestId: string;
  state: string;
  resourceId: string;
  capabilities: AuthCapability[];
  instanceId: string;
};

type InstanceAuthCallbackPointer = {
  v: 1;
  requestId: string;
  resourceId: string;
  instanceId: string;
  pendingKey: string;
  createdAt: string;
};

const sessionRefreshes = new Map<string, Promise<CloudSessionCredential>>();

type StoredAuthInstance = AuthInstance & { updatedAt: string };
type ActiveInstancePointer = { v: 1; instanceId: string; updatedAt: string };

type StoredCloudSessionCredential = {
  v: 1;
  mfid: string;
  resourceId: string;
  instanceId: string;
  credential: CloudSessionCredential;
  storedAt?: string;
};

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CALLBACK_FRAGMENT_PARAM = "mf_auth_result";
const DEFAULT_AUTH_IDB_NAME = "mf-sdk-auth-v1";
const BUCKET_ACCESS_CACHE_TTL_MS = 60_000;
const INSTANCE_SESSION_USABLE_WINDOW_MS = 2 * 60 * 1000;
const INSTANCE_SESSION_BEST_EFFORT_REFRESH_WINDOW_MS = 60 * 60 * 1000;
const FIXED_CAPABILITIES: AuthCapability[] = ["read", "write"];

export function createInstanceAuthClient(options: InstanceAuthClientOptions = {}): InstanceAuthClient {
  let instance: AuthInstance | null = null;
  const appId = normalizeInstanceAppId(options.appId);
  let mfid = "";
  let currentResourceId = "";
  const sessions = new Map<string, CloudSessionCredential>();
  const storage = options.storage || createIndexedDbStorageAdapter({ dbName: DEFAULT_AUTH_IDB_NAME, storeName: "instance" });
  const fetchImpl = options.fetchImpl || fetch;
  const bucketAccessCache = new Map<string, { access: BucketAccess; expiresAt: number }>();

  const activeInstanceKey = () => `instance:${seg(appId)}:active-instance:current`;
  const instanceKey = (instanceId: string) => `instance:${seg(appId)}:instance-key:${seg(instanceId)}`;
  const pendingAuthKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:pending-auth:${seg(resourceId)}:${seg(instanceId)}`;
  const callbackPointerKey = (requestId: string) => `instance:${seg(appId)}:callback-pointer:${seg(requestId)}`;
  const contextKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:context:${seg(resourceId)}:${seg(instanceId)}`;
  const sessionKey = (resourceId: string, instanceId: string) => `instance:${seg(appId)}:session:${seg(resourceId)}:${seg(instanceId)}`;

  function isStoredAuthInstance(value: AuthInstance | null, instanceId?: string): value is AuthInstance {
    return (
      !!value &&
      value.v === 1 &&
      isValidInstanceId(value.instanceId) &&
      (!instanceId || value.instanceId === instanceId) &&
      value.signingPrivateKey instanceof CryptoKey &&
      value.wrappingPrivateKey instanceof CryptoKey &&
      value.signingPrivateKey.type === "private" && !value.signingPrivateKey.extractable &&
      value.signingPrivateKey.algorithm.name === "ECDSA" && value.signingPrivateKey.usages.includes("sign") &&
      value.wrappingPrivateKey.type === "private" && !value.wrappingPrivateKey.extractable &&
      value.wrappingPrivateKey.algorithm.name === "ECDH" && value.wrappingPrivateKey.usages.includes("deriveBits") &&
      !!value.signingPublicJwk && !!value.wrappingPublicJwk
    );
  }

  async function readStoredInstance(instanceId: string): Promise<StoredAuthInstance | null> {
    const stored = await storage.get<StoredAuthInstance>(instanceKey(instanceId));
    if (stored !== null && !isStoredAuthInstance(stored, instanceId)) throw new ClientError("INVALID_INSTANCE", "Stored instance keys are invalid");
    return stored;
  }

  async function readActiveStoredInstance(): Promise<StoredAuthInstance | null> {
    const active = await storage.get<ActiveInstancePointer>(activeInstanceKey());
    if (active === null) return null;
    if (active.v !== 1 || !isValidInstanceId(active.instanceId)) throw new ClientError("INVALID_INSTANCE", "Stored instance pointer is invalid");
    const stored = await readStoredInstance(active.instanceId);
    if (!stored) throw new ClientError("INVALID_INSTANCE", "Stored instance keys are missing");
    return stored;
  }

  let initialization: Promise<StoredAuthInstance> | null = null;
  function getInstanceKey(): Promise<StoredAuthInstance> {
    if (initialization) return initialization;
    initialization = (async () => {
      const active = await readActiveStoredInstance();
      if (active) {
        if (options.instanceKey && options.instanceKey.instanceId !== active.instanceId) throw new ClientError("IDENTITY_MISMATCH", "A different instance is already stored");
        options.onIdentity?.(active);
        return instance = active;
      }
      const created = options.instanceKey ?? await createInstanceKey();
      if (!isStoredAuthInstance(created) || created.instanceId !== await deriveInstanceId(created.signingPublicJwk)) throw new ClientError("INVALID_INPUT", "Invalid instance key");
      const stored = { ...created, updatedAt: new Date().toISOString() };
      await storage.set(instanceKey(created.instanceId), stored);
      if (!await readStoredInstance(created.instanceId)) throw new ClientError("STORAGE_ERROR", "Instance keys did not persist");
      const pointer: ActiveInstancePointer = { v: 1, instanceId: created.instanceId, updatedAt: stored.updatedAt };
      const won = storage.add ? await storage.add(activeInstanceKey(), pointer)
        : await storage.get(activeInstanceKey()) === null && (await storage.set(activeInstanceKey(), pointer), true);
      if (won) { options.onIdentity?.(stored); return instance = stored; }
      const winner = await readActiveStoredInstance();
      if (!winner) throw new ClientError("STORAGE_ERROR", "Instance initialization lost its active pointer");
      if (winner.instanceId !== created.instanceId) await storage.remove(instanceKey(created.instanceId));
      if (options.instanceKey && options.instanceKey.instanceId !== winner.instanceId) throw new ClientError("IDENTITY_MISMATCH", "A different instance is already stored");
      options.onIdentity?.(winner);
      return instance = winner;
    })().finally(() => { initialization = null; });
    return initialization;
  }

  async function readContext(resourceId: string): Promise<InstanceAuthContext | null> {
    if (!parseBucketResourceId(resourceId)) return null;
    const authInstance = await readActiveStoredInstance();
    if (!authInstance) return null;
    options.onIdentity?.(authInstance);
    const context = await storage.get<InstanceAuthContext>(contextKey(resourceId, authInstance.instanceId));
    if (
      !context ||
      context.v !== 1 ||
      !isValidMfid(context.mfid) ||
      context.resourceId !== resourceId ||
      (context.remoteResourceId !== undefined && !parseBucketResourceId(context.remoteResourceId)) ||
      context.instanceId !== authInstance.instanceId
    ) {
      return null;
    }
    mfid = context.mfid;
    currentResourceId = context.resourceId;
    instance = authInstance;
    return context;
  }

  async function getSessionForResource(resourceId: string, sessionOptions?: { forceRefresh?: boolean }): Promise<CloudSessionCredential> {
    const context = await readContext(resourceId);
    if (!context) throw new ClientError("NOT_AUTHORIZED", "Authorize this bucket before requesting a session");
    const mfid = context.mfid;
    const authInstance = await getInstanceKey();
    if (authInstance.instanceId !== context.instanceId) throw new Error("stored instance does not match authorization context");
    const sessionResourceId = context.remoteResourceId || context.resourceId;
    const forceRefresh = sessionOptions?.forceRefresh === true;
    const apiBase = (context.resourceApiUrl || options.apiBase || browserLocationOrigin()).replace(/\/+$/, "").replace(/\/v1\/api\/sync$/, "");
    const refreshSessionKey = JSON.stringify([apiBase, mfid, sessionResourceId, authInstance.instanceId, context.bucketAccessGrant?.grantRecordId]);

    const performRefreshSession = async (): Promise<CloudSessionCredential> => {
      const identity = { mfid, resourceId: sessionResourceId, instanceId: authInstance.instanceId };
      const session = options.createSession
        ? await options.createSession(apiBase, authInstance, identity)
        : await createSessionClient({ apiBase, fetch: fetchImpl, instanceKey: authInstance }).createSession(identity);
      return session.credential;
    };

    const refreshSession = async (): Promise<CloudSessionCredential> => {
      let promise = sessionRefreshes.get(refreshSessionKey);
      if (!promise) {
        promise = performRefreshSession().finally(() => {
          if (sessionRefreshes.get(refreshSessionKey) === promise) sessionRefreshes.delete(refreshSessionKey);
        });
        sessionRefreshes.set(refreshSessionKey, promise);
      }
      const credential = await promise;
      const current = await readContext(resourceId);
      if (!current || current.instanceId !== context.instanceId || current.mfid !== mfid
        || current.remoteResourceId !== context.remoteResourceId
        || current.bucketAccessGrant?.grantRecordId !== context.bucketAccessGrant?.grantRecordId) {
        throw new ClientError("AUTHORIZATION_CHANGED", "Authorization changed while refreshing the session");
      }
      await storage.set(sessionKey(sessionResourceId, context.instanceId), {
        v: 1, mfid, resourceId: sessionResourceId, instanceId: authInstance.instanceId,
        credential, storedAt: new Date().toISOString(),
      } satisfies StoredCloudSessionCredential);
      sessions.set(refreshSessionKey, credential);
      return credential;
    };

    if (!forceRefresh) {
      let cachedCredential: CloudSessionCredential | null = null;
      const current = sessions.get(refreshSessionKey);
      if (current && isSessionUsable(current)) {
        cachedCredential = current;
      } else {
        const stored = await storage.get<StoredCloudSessionCredential>(sessionKey(sessionResourceId, context.instanceId));
        if (
          stored?.v === 1 &&
          stored.mfid === mfid &&
          stored.resourceId === sessionResourceId &&
          stored.instanceId === authInstance.instanceId &&
          isSessionUsable(stored.credential)
        ) {
          sessions.set(refreshSessionKey, stored.credential);
          cachedCredential = stored.credential;
        }
      }
      if (cachedCredential) {
        if (shouldBestEffortRefreshSession(cachedCredential)) void refreshSession().catch(() => undefined);
        return cachedCredential;
      }
    }

    return refreshSession();
  }

  async function prepareAuthorization(request: { bucketId: string }, signal?: AbortSignal): Promise<AuthorizationRequest> {
    const resourceId = bucketResourceId(requireValidBucketId(request.bucketId));
    const authInstance = await getInstanceKey();
    signal?.throwIfAborted();
    currentResourceId = resourceId;
    const state = randomId("state");
    const requestId = randomId("req");
    const nextPendingKey = pendingAuthKey(resourceId, authInstance.instanceId);
    const redirectUri = options.redirectUri || browserLocationHref();
    const createdAt = new Date().toISOString();
    const fragment = buildAuthRequestFragment({
      clientId: appId,
      requestId,
      state,
      redirectUri,
      origin: options.origin || browserLocationOrigin(),
      resourceId,
      capabilities: FIXED_CAPABILITIES,
      instanceId: authInstance.instanceId,
      instanceSigningPublicJwk: authInstance.signingPublicJwk,
      instanceWrappingPublicJwk: authInstance.wrappingPublicJwk,
      createdAt,
    });
    const previous = await storage.get<PendingInstanceAuthRequest>(nextPendingKey);
    signal?.throwIfAborted();
    await storage.set(nextPendingKey, {
      redirectUri,
      v: 1,
      requestId,
      state,
      resourceId,
      capabilities: FIXED_CAPABILITIES,
      instanceId: authInstance.instanceId,
    } satisfies PendingInstanceAuthRequest);
    if (previous?.requestId) await storage.remove(callbackPointerKey(previous.requestId));
    await storage.set(callbackPointerKey(requestId), {
      v: 1,
      requestId,
      resourceId,
      instanceId: authInstance.instanceId,
      pendingKey: nextPendingKey,
      createdAt,
    } satisfies InstanceAuthCallbackPointer);
    const authPageUrl = String(options.authPageUrl || "").trim();
    if (!authPageUrl) throw new Error("authPageUrl is required to authorize an instance");
    const authUrl = `${authPageUrl}${fragment}`;
    const value = { url: authUrl, requestId, state, resourceId, instanceId: authInstance.instanceId, redirectUri, createdAt };
    if (signal?.aborted) { await cancelAuthorization(requestId); signal.throwIfAborted(); }
    return value;
  }
  async function cancelAuthorization(requestId: string): Promise<void> {
    const pointer = await storage.get<InstanceAuthCallbackPointer>(callbackPointerKey(requestId));
    if (!pointer) return;
    const pending = await storage.get<PendingInstanceAuthRequest>(pointer.pendingKey);
    if (pending?.requestId === requestId) await storage.remove(pointer.pendingKey);
    await storage.remove(callbackPointerKey(requestId));
  }

  return {
    async ensureInstance() {
      return getInstanceKey();
    },
    prepareAuthorization,
    cancelAuthorization,
    async authorize(request) {
      const pending = await prepareAuthorization(request);
      if (options.openAuthUrl) { await options.openAuthUrl(pending.url); return; }
      if (typeof window === "undefined") throw new Error("browser window required for authorize redirect");
      window.location.href = pending.url;
    },
    async handleCallback(url, callbackOptions = {}) {
      const check = () => callbackOptions.signal?.throwIfAborted();
      check();
      const parsed = url && /^[a-z][a-z0-9+.-]*:/i.test(url) ? new URL(url) : new URL(url || browserLocationHref(), browserLocationOrigin());
      const result: AuthCallbackResult = {
        requestId: parsed.searchParams.get("mf_request_id") || "",
        state: parsed.searchParams.get("state") || "",
        result: (parsed.searchParams.get("mf_result") || (parsed.searchParams.get("error") ? "error" : "")) as AuthCallbackResult["result"],
        ...(parsed.searchParams.get("error") ? { error: parsed.searchParams.get("error") || undefined } : {}),
        ...(parsed.searchParams.get("error_description") ? { errorDescription: parsed.searchParams.get("error_description") || undefined } : {}),
      };
      if (!result.requestId || !result.state || !["approved", "denied", "error"].includes(result.result)) return null;
      const pointer = await storage.get<InstanceAuthCallbackPointer>(callbackPointerKey(result.requestId));
      if (!pointer || pointer.v !== 1 || pointer.requestId !== result.requestId) return null;
      if (!isFresh(pointer.createdAt)) { await cancelAuthorization(result.requestId); return null; }
      const expected = await storage.get<PendingInstanceAuthRequest>(pointer.pendingKey);
      if (!expected || expected.v !== 1 || expected.requestId !== result.requestId || expected.state !== result.state) return null;
      check();
      const redirect = new URL(expected.redirectUri || options.redirectUri || browserLocationHref());
      if (parsed.origin !== redirect.origin || parsed.pathname !== redirect.pathname) throw new ClientError("INVALID_AUTHORIZATION", "Callback destination mismatch");
      result.resourceId = expected.resourceId;
      async function clearRequest(): Promise<void> {
        const pending = await storage.get<PendingInstanceAuthRequest>(pointer!.pendingKey);
        if (pending?.requestId === result.requestId) await storage.remove(pointer!.pendingKey);
        await storage.remove(callbackPointerKey(result.requestId));
      }
      if (result.result === "approved") {
        const authInstance = await readStoredInstance(expected.instanceId);
        if (!authInstance) return { ...result, result: "error", error: "server_error", errorDescription: "authorization_instance_missing" };
        let stored: StoredAuthAuthorizationResult;
        try {
          stored = await readAuthorizationResult(parsed, {
            requestId: expected.requestId, state: expected.state, resourceId: expected.resourceId,
            instanceId: expected.instanceId,
          }, authInstance.wrappingPrivateKey);
        } catch {
          return { ...result, result: "error", error: "server_error", errorDescription: "authorization_result_invalid" };
        }
        if (stored.resourceId !== pointer.resourceId || stored.instanceId !== pointer.instanceId) {
          return { ...result, result: "error", error: "server_error", errorDescription: "authorization_context_mismatch" };
        }
        async function checkIdentity(): Promise<void> {
          if ((await readActiveStoredInstance())?.instanceId === authInstance!.instanceId) return;
          await clearRequest();
          throw new ClientError("IDENTITY_MISMATCH", "Authorization belongs to a different active instance");
        }
        check();
        const authorization = await authorizationContext(stored, authInstance);
        check();
        await checkIdentity();
        if ((await storage.get<PendingInstanceAuthRequest>(pointer.pendingKey))?.requestId !== result.requestId) throw new ClientError("AUTHORIZATION_CANCELLED", "Authorization replaced by a new request");
        check();
        options.onIdentity?.(authInstance);
        check();
        if (callbackOptions.persist === false) { await clearRequest(); check(); return { ...result, authorization }; }
        const remoteResourceId = stored.bucketAccessGrant?.resourceId || stored.resourceId;
        const nextContext: InstanceAuthContext = {
          v: 1, mfid: stored.mfid, resourceId: stored.resourceId,
          ...(remoteResourceId !== stored.resourceId ? { remoteResourceId } : {}),
          ...(stored.resourceApiUrl ? { resourceApiUrl: stored.resourceApiUrl } : {}),
          instanceId: stored.instanceId, requestId: result.requestId,
          authorizedAt: new Date().toISOString(),
          ...(stored.bucketAccessGrant ? { bucketAccessGrant: stored.bucketAccessGrant } : {}),
        };
        check();
        await clearRequest();
        check();
        await storage.remove(sessionKey(remoteResourceId, stored.instanceId));
        check();
        await storage.set(contextKey(stored.resourceId, stored.instanceId), nextContext);
        if (callbackOptions.signal?.aborted) {
          const key = contextKey(stored.resourceId, stored.instanceId);
          if ((await storage.get<InstanceAuthContext>(key))?.requestId === result.requestId) await storage.remove(key);
          check();
        }
        mfid = stored.mfid;
        currentResourceId = stored.resourceId;
        sessions.clear();
        bucketAccessCache.clear();
        return result;
      }
      await clearRequest();
      return result;
    },
    getContext: (bucketId) => readContext(bucketResourceId(requireValidBucketId(bucketId))),
    getSession: (bucketId, sessionOptions) => getSessionForResource(bucketResourceId(requireValidBucketId(bucketId)), sessionOptions),
    async getBucketAccess(bucketId) {
      const safeBucketId = requireValidBucketId(bucketId);
      const resourceId = bucketResourceId(safeBucketId);
      const context = await readContext(resourceId);
      if (!context) throw new ClientError("NOT_AUTHORIZED", "Authorize this bucket first");
      const mfid = context.mfid;
      const authInstance = await getInstanceKey();
      if (authInstance.instanceId !== context.instanceId) throw new Error("stored instance does not match authorization context");
      const cacheKey = JSON.stringify([mfid, safeBucketId, authInstance.instanceId, context.bucketAccessGrant?.grantRecordId, context.resourceApiUrl]);
      const cached = bucketAccessCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.access;
      const grant = normalizeBucketAccessGrant(context.bucketAccessGrant);
      const remoteResourceId = context.remoteResourceId || resourceId;
      if (!grant || grant.mfid !== mfid || grant.instanceId !== authInstance.instanceId || grant.resourceId !== remoteResourceId) {
        throw new Error("bucket access grant unavailable; reauthorize required");
      }
      const keys = await unwrapBucketKeys(grant.envelope, authInstance.wrappingPrivateKey);
      if (bucketResourceId(keys.bucketId) !== remoteResourceId) throw new ClientError("INVALID_AUTHORIZATION", "Bucket key does not match the authorized resource");
      const access: BucketAccess = {
        mfid,
        instanceId: authInstance.instanceId,
        bucketId: keys.bucketId,
        resourceId: remoteResourceId,
        ...(context.resourceApiUrl ? { resourceApiUrl: context.resourceApiUrl } : {}),
        capabilities: grant.capabilities,
        grantRecordId: grant.grantRecordId,
        keys,
      };
      bucketAccessCache.set(cacheKey, { access, expiresAt: Date.now() + BUCKET_ACCESS_CACHE_TTL_MS });
      return access;
    },
    async clearContext(bucketId) {
      const resourceId = bucketResourceId(requireValidBucketId(bucketId));
      const authInstance = await readActiveStoredInstance();
      if (authInstance) {
        const context = await readContext(resourceId);
        await storage.remove(contextKey(resourceId, authInstance.instanceId));
        await storage.remove(sessionKey(context?.remoteResourceId || resourceId, authInstance.instanceId));
      }
      if (currentResourceId === resourceId || !authInstance) { mfid = ""; currentResourceId = ""; }
      sessions.clear();
      bucketAccessCache.clear();
    },
  };
}

type AuthRequestFields = {
  clientId: string;
  requestId: string;
  state: string;
  redirectUri: string;
  origin: string;
  resourceId: string;
  capabilities: AuthCapability[];
  instanceId: string;
  instanceSigningPublicJwk: JsonWebKey;
  instanceWrappingPublicJwk: JsonWebKey;
  createdAt: string;
};

export function buildAuthRequestFragment(request: AuthRequestFields): string {
  if (!request.requestId || !request.state) throw new Error("auth request state required");
  if (!isValidInstanceId(request.instanceId)) throw new Error("invalid instanceId");
  if (!isPublicP256EcJwk(request.instanceSigningPublicJwk)) throw new Error("instanceSigningPublicJwk required");
  if (!isPublicP256EcJwk(request.instanceWrappingPublicJwk)) throw new Error("instanceWrappingPublicJwk required");
  const redirect = new URL(request.redirectUri);
  const origin = new URL(request.origin);
  if (redirect.origin !== origin.origin) throw new Error("redirectUri origin mismatch");
  const wire = {
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    scope: request.capabilities.join(" "),
    resource_id: request.resourceId,
    mf_v: 1,
    mf_auth_mode: "v1",
    mf_request_id: request.requestId,
    mf_instance_id: request.instanceId,
    mf_instance_signing_jwk: request.instanceSigningPublicJwk,
    mf_instance_wrapping_jwk: request.instanceWrappingPublicJwk,
    mf_issued_at: request.createdAt,
  };
  return `#authRequest=${bytesToB64url(utf8Encode(stableStringify(wire)))}`;
}

function parseEncryptedAuthAuthorizationResultFragment(fragmentOrUrl: string): EncryptedAuthAuthorizationResultEnvelope | null {
  const input = String(fragmentOrUrl || "");
  const rawFragment = input.includes("#") ? input.slice(input.indexOf("#") + 1) : input.replace(/^#/, "");
  if (!rawFragment) return null;
  const encoded = new URLSearchParams(rawFragment).get(AUTH_CALLBACK_FRAGMENT_PARAM);
  if (!encoded) return null;
  const envelope = JSON.parse(new TextDecoder().decode(b64urlToBytes(encoded))) as Partial<EncryptedAuthAuthorizationResultEnvelope> | null;
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.typ !== "auth.authorization-result.envelope.v1" ||
    envelope.alg !== "ECDH-HKDF-SHA-256/AES-GCM-256" ||
    typeof envelope.requestId !== "string" ||
    typeof envelope.state !== "string" ||
    !parseBucketResourceId(envelope.resourceId) ||
    !isValidInstanceId(envelope.instanceId || "") ||
    !isPublicP256EcJwk(envelope.ephemeralPublicJwk) ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.aad !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("auth callback result fragment invalid");
  }
  return envelope as EncryptedAuthAuthorizationResultEnvelope;
}

export async function readAuthorizationResult(url: URL, expected: {
  requestId: string; state: string; resourceId: string; instanceId: string;
}, wrappingPrivateKey: CryptoKey): Promise<StoredAuthAuthorizationResult> {
  if (url.searchParams.get("mf_request_id") !== expected.requestId || url.searchParams.get("state") !== expected.state) {
    throw new ClientError("INVALID_AUTHORIZATION", "Authorization callback does not match the request");
  }
  if (url.searchParams.get("mf_result") !== "approved") {
    throw new ClientError("AUTHORIZATION_DENIED", "Authorization was not approved");
  }
  const envelope = parseEncryptedAuthAuthorizationResultFragment(url.hash);
  if (!envelope) throw new ClientError("INVALID_AUTHORIZATION", "Encrypted authorization result is missing");
  return decryptEncryptedAuthAuthorizationResult({ envelope, instanceWrappingPrivateKey: wrappingPrivateKey,
    expectedRequestId: expected.requestId, expectedState: expected.state,
    expectedResourceId: expected.resourceId, expectedInstanceId: expected.instanceId });
}

export async function decryptEncryptedAuthAuthorizationResult(input: {
  envelope: EncryptedAuthAuthorizationResultEnvelope;
  instanceWrappingPrivateKey: CryptoKey;
  expectedRequestId?: string;
  expectedState?: string;
  expectedResourceId?: string;
  expectedInstanceId?: string;
}): Promise<StoredAuthAuthorizationResult> {
  const { envelope } = input;
  if (
    (input.expectedRequestId && envelope.requestId !== input.expectedRequestId) ||
    (input.expectedState && envelope.state !== input.expectedState) ||
    (input.expectedResourceId && envelope.resourceId !== input.expectedResourceId) ||
    (input.expectedInstanceId && envelope.instanceId !== input.expectedInstanceId)
  ) {
    throw new Error("auth callback result mismatch");
  }
  const ephemeralPublic = await crypto.subtle.importKey("jwk", envelope.ephemeralPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublic }, input.instanceWrappingPrivateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: b64urlToBytes(envelope.salt) as BufferSource, info: utf8Encode(envelope.aad) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(envelope.iv) as BufferSource, additionalData: utf8Encode(envelope.aad) },
    wrappingKey,
    b64urlToBytes(envelope.ciphertext) as BufferSource
  );
  const result = normalizeAuthAuthorizationResult(JSON.parse(new TextDecoder().decode(plaintext)), envelope.requestId);
  if (
    !result ||
    result.state !== envelope.state ||
    result.resourceId !== envelope.resourceId ||
    result.instanceId !== envelope.instanceId ||
    (input.expectedState && result.state !== input.expectedState) ||
    (input.expectedResourceId && result.resourceId !== input.expectedResourceId) ||
    (input.expectedInstanceId && result.instanceId !== input.expectedInstanceId)
  ) {
    throw new Error("auth callback result mismatch");
  }
  return result;
}

function normalizeAuthAuthorizationResult(value: unknown, expectedRequestId?: string): StoredAuthAuthorizationResult | null {
  const row = value as Partial<StoredAuthAuthorizationResult> | null;
  if (
    !row ||
    row.v !== 1 ||
    row.result !== "approved" ||
    typeof row.requestId !== "string" ||
    (expectedRequestId && row.requestId !== expectedRequestId) ||
    typeof row.state !== "string" ||
    !isValidMfid(row.mfid || "") ||
    !parseBucketResourceId(row.resourceId) ||
    !isValidInstanceId(row.instanceId || "") ||
    typeof row.createdAt !== "string"
  ) {
    return null;
  }
  if (row.expiresAt !== undefined) {
    const expiresAt = Date.parse(String(row.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }
  const resource = parseBucketResourceId(row.resourceId);
  if (!resource) return null;
  const bucketAccessGrant = normalizeBucketAccessGrant(row.bucketAccessGrant);
  if (!bucketAccessGrant) return null;
  if (bucketAccessGrant.mfid !== row.mfid || !parseBucketResourceId(bucketAccessGrant.resourceId) || bucketAccessGrant.instanceId !== row.instanceId) {
    return null;
  }
  return {
    v: 1,
    requestId: row.requestId,
    state: row.state,
    result: "approved",
    mfid: row.mfid!,
    resourceId: resource.resourceId,
    instanceId: row.instanceId!,
    createdAt: row.createdAt,
    ...(typeof row.resourceApiUrl === "string" && row.resourceApiUrl.trim() ? { resourceApiUrl: row.resourceApiUrl.trim() } : {}),
    bucketAccessGrant,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
  };
}

export function normalizeBucketAccessGrant(value: unknown): BucketAccessGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<BucketAccessGrant>;
  const resource = parseBucketResourceId(row.resourceId);
  const capabilities = normalizeCapabilities(row.capabilities);
  if (
    row.v !== 1 ||
    !/^ar_[a-f0-9]{32}$/.test(String(row.grantRecordId || "")) ||
    !isValidMfid(row.mfid) ||
    !resource ||
    !isValidInstanceId(row.instanceId) ||
    !/^bk_[a-f0-9]{32}$/.test(String(row.keyId || "")) ||
    capabilities.length < 1 ||
    !isValidBucketKeyGrantEnvelope(row.envelope, row.instanceId, row.keyId)
  ) {
    return null;
  }
  return {
    v: 1,
    grantRecordId: row.grantRecordId!,
    mfid: row.mfid!,
    resourceId: resource.resourceId,
    instanceId: row.instanceId!,
    issuedAt: String(row.issuedAt || ""),
    keyId: row.keyId!,
    capabilities,
    envelope: row.envelope as BucketKeyGrantEnvelope,
  };
}

function isValidBucketKeyGrantEnvelope(value: unknown, instanceId?: string, keyId?: string): value is BucketKeyGrantEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<BucketKeyGrantEnvelope>;
  if (
    row.kind !== "bucket-key" ||
    !isValidBucketId(row.bucketId) ||
    !/^bk_[a-f0-9]{32}$/.test(String(row.keyId || "")) ||
    !isValidInstanceId(row.targetInstanceId) ||
    row.wrapAlg !== "ECDH-HKDF-SHA-256/AES-GCM-256" ||
    !isPublicP256EcJwk(row.targetWrappingPublicJwk) ||
    !isPublicP256EcJwk(row.ephemeralPublicJwk) ||
    typeof row.salt !== "string" ||
    typeof row.iv !== "string" ||
    typeof row.aad !== "string" ||
    typeof row.ciphertext !== "string"
  ) {
    return false;
  }
  if (instanceId && row.targetInstanceId !== instanceId) return false;
  if (keyId && row.keyId !== keyId) return false;
  return true;
}

export function bucketResourceId(bucketId: string): string {
  return `urn:myfield:bucket:${bucketId}`;
}

function parseBucketResourceId(resourceId: unknown): { resourceId: string; bucketId: string } | null {
  const safe = typeof resourceId === "string" ? resourceId.trim() : "";
  const prefix = "urn:myfield:bucket:";
  if (!safe.startsWith(prefix)) return null;
  const bucketId = safe.slice(prefix.length);
  return isValidBucketId(bucketId) ? { resourceId: safe, bucketId } : null;
}

function normalizeCapabilities(input: unknown): AuthCapability[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<AuthCapability>(["read", "write"]);
  const result: AuthCapability[] = [];
  for (const item of input) {
    if (allowed.has(item as AuthCapability) && !result.includes(item as AuthCapability)) result.push(item as AuthCapability);
  }
  return result.sort();
}

function getSessionRemainingMs(session: CloudSessionCredential | null): number | null {
  if (!session || session.carrier !== "bearer") return null;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt - Date.now() : null;
}

function isSessionUsable(session: CloudSessionCredential | null): session is CloudSessionCredential {
  const remainingMs = getSessionRemainingMs(session);
  return remainingMs !== null && remainingMs > INSTANCE_SESSION_USABLE_WINDOW_MS;
}

function shouldBestEffortRefreshSession(session: CloudSessionCredential): boolean {
  const remainingMs = getSessionRemainingMs(session);
  return remainingMs !== null && remainingMs > INSTANCE_SESSION_USABLE_WINDOW_MS && remainingMs <= INSTANCE_SESSION_BEST_EFFORT_REFRESH_WINDOW_MS;
}

function isFresh(createdAt: string): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && Date.now() - created <= AUTH_REQUEST_TTL_MS;
}

export function isValidBucketId(value: unknown): value is string {
  const safe = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(safe) && !safe.includes("..");
}

function requireValidBucketId(value: unknown): string {
  if (!isValidBucketId(value)) throw new Error("invalid bucketId");
  return value;
}

function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^inst_[a-f0-9]{32}$/.test(value);
}

function isValidMfid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isPublicP256EcJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwk = value as JsonWebKey;
  return !("d" in jwk) && jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && jwk.x.length > 0 && typeof jwk.y === "string" && jwk.y.length > 0;
}

function normalizeInstanceAppId(value: unknown): string {
  const safe = typeof value === "string" ? value.trim() : "";
  return isValidBucketId(safe) ? safe : "myfield.sdk";
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function jwkCore(jwk: JsonWebKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["kty", "crv", "x", "y", "kid", "alg", "use"] as const) {
    const value = (jwk as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function browserLocationHref(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.href;
}

function browserLocationOrigin(): string {
  if (typeof window === "undefined") throw new Error("browser window required");
  return window.location.origin;
}
