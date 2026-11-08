import { openAuthorizationPopup, hasAuthorizationCallback, clearCallbackUrl, type AuthorizationFlow } from "../auth/flow.ts";
import type { InstanceAuthClient } from "../auth/instance.ts";
import { combineSignals, releaseResponse } from "../internal/abort.ts";
import { createAuthorizationClient, type AuthorizationClient, type AuthorizationContext } from "../auth/client.ts";
import type { InstanceKey } from "../crypto/instance.ts";
import { ClientError } from "../errors.ts";
import { createBucketRemote, type BucketRemote } from "./bucket.ts";
import { createSessionClient, type SessionClient, type BearerCredential, type InstanceSessionInput, type InstanceSession } from "./session.ts";
import { createHttp } from "./http.ts";

/** Authorization requests and session exchange using the owning Instance identity. @public */
export interface RemoteAuth extends SessionClient {
  /** Starts a popup authorization and returns verified access without saving or binding it. */
  authorize(options?: { mode?: "popup"; bucketId?: string; signal?: AbortSignal }): Promise<AuthorizationContext>;
  /** Saves pending state and the identity before navigating in this tab. */
  authorize(options: { mode: "redirect"; bucketId?: string; signal?: AbortSignal }): Promise<void>;
  authorize(options: { mode: "popup" | "redirect"; bucketId?: string; signal?: AbortSignal }): Promise<AuthorizationContext | void>;
  /** Restores a same-tab callback from the current URL; returns null when absent. */
  handleCallback(): Promise<AuthorizationContext | null>;
}

/** Default remote resources; bindings are in memory and never persisted automatically. @public */
export interface Remote {
  authBase: string;
  readonly apiBase: string | undefined;
  readonly authorization: AuthorizationContext | null;
  /** Binds verified/restored access in memory; sessions are acquired on demand. */
  bind(authorization: AuthorizationContext): void;
  /** Clears in-memory access without deleting saved authorization or revoking access. */
  unbind(): void;
  readonly auth: RemoteAuth;
  readonly bucket: BucketRemote;
}

const authBases = new WeakMap<Remote, () => string | undefined>();
export function configuredAuthBase(remote: Remote): string | undefined { return authBases.get(remote)?.(); }

export type LocalOperation = {
  active(): boolean;
  publish(grant: AuthorizationContext, provider: () => Promise<BearerCredential>): void;
};
type LocalBinding = {
  fetch: typeof fetch;
  exchange(apiBase: string, identity: InstanceKey, input: InstanceSessionInput): Promise<InstanceSession>;
  readonly generation: number;
  run<T>(action: (operation: LocalOperation) => Promise<T>, generation?: number): Promise<T>;
  reset(): void;
};
const localBindings = new WeakMap<Remote, LocalBinding>();
export function localBinding(remote: Remote): LocalBinding { return localBindings.get(remote)!; }

const disposers = new WeakMap<Remote, () => void>();
export function disposeRemote(remote: Remote): void { disposers.get(remote)?.(); }

export function createRemote(options: { appId: string; getIdentity(): InstanceKey | null; authBase?: string; fetch?: typeof fetch; authorizationFlow: AuthorizationFlow; persistentAuth: boolean; getStoredAuth(): Promise<InstanceAuthClient> }): Remote {
  const controller = new AbortController();
  function alive(): void { if (controller.signal.aborted) throw new ClientError("INSTANCE_DISPOSED", "Instance has been disposed"); }
  const fetchRemote: typeof fetch = async (input, init = {}) => {
    alive();
    const scope = combineSignals(init.signal ? [init.signal, controller.signal] : [controller.signal]);
    try {
      return releaseResponse(await (options.fetch ?? globalThis.fetch)(input, { ...init, signal: scope.signal }), scope.dispose);
    } catch (error) { scope.dispose?.(); throw error; }
  };
  let explicitAuthBase = options.authBase !== undefined;
  let authBase = options.authBase ?? "https://myfield.one/auth/", apiBase: string | undefined;
  let grant: AuthorizationContext | undefined;
  let managed = false, generation = 0;
  const operations = new Set<object>();
  let getCredential: (() => Promise<BearerCredential>) | undefined;
  function writable(): void {
    alive();
    if (managed || operations.size) throw new ClientError("REMOTE_MANAGED", "Local manages this Remote; disconnect before binding access");
  }
  let session: { base: string; key: InstanceKey; client: SessionClient } | undefined;
  function key(): InstanceKey {
    alive();
    const value = options.getIdentity();
    if (!value) throw new ClientError("INSTANCE_KEY_REQUIRED", "Provide instanceKey or restore the local identity before using remote auth");
    return value;
  }
  function base(): string {
    alive();
    if (!apiBase) throw new ClientError("REMOTE_NOT_CONFIGURED", "apiBase must come from authorization");
    return apiBase;
  }
  function authorization(): AuthorizationClient {
    return createAuthorizationClient({ appId: options.appId, instanceKey: key(), authBase });
  }
  function authorize(input?: { mode?: "popup"; bucketId?: string; signal?: AbortSignal }): Promise<AuthorizationContext>;
  function authorize(input: { mode: "redirect"; bucketId?: string; signal?: AbortSignal }): Promise<void>;
  function authorize(input: { mode: "popup" | "redirect"; bucketId?: string; signal?: AbortSignal }): Promise<AuthorizationContext | void>;
  async function authorize(input: { mode?: "popup" | "redirect"; bucketId?: string; signal?: AbortSignal } = {}): Promise<AuthorizationContext | void> {
    alive();
    if (!input || typeof input !== "object" || (input.mode !== undefined && !["popup", "redirect"].includes(input.mode))) throw new ClientError("INVALID_INPUT", "Invalid authorization mode");
    const scope = combineSignals(input.signal ? [input.signal, controller.signal] : [controller.signal]);
    try {
      if (input.mode === "redirect") {
        if (!options.persistentAuth) throw new ClientError("AUTH_STORAGE_REQUIRED", "Same-tab authorization requires persistent auth storage");
        key();
        return await options.authorizationFlow.run(async signal => {
          const client = await options.getStoredAuth();
          const request = await client.prepareAuthorization({ bucketId: input.bucketId ?? options.appId }, signal);
          options.authorizationFlow.identify(signal, request.requestId);
          signal.addEventListener("abort", () => {
            if (signal.reason?.code !== "INSTANCE_DISPOSED") void client.cancelAuthorization(request.requestId).catch(() => {});
          }, { once: true });
          signal.throwIfAborted();
          window.location.href = request.url;
        }, scope.signal, true);
      }
      const client = authorization(), request = client.createRequest(input);
      return await options.authorizationFlow.run(signal => {
        options.authorizationFlow.identify(signal, request.requestId);
        return openAuthorizationPopup({ request, signal, callback: (url, pending) => client.handleCallback(url, pending) });
      }, scope.signal);
    } finally { scope.dispose?.(); }
  }
  const auth: RemoteAuth = {
    authorize,
    async handleCallback() {
      alive();
      if (typeof window === "undefined" || !hasAuthorizationCallback(window.location.href)) return null;
      const requestId = new URL(window.location.href).searchParams.get("mf_request_id");
      if (!requestId) throw new ClientError("INVALID_AUTHORIZATION", "Authorization callback is missing requestId");
      return options.authorizationFlow.restore(requestId, async signal => {
        const client = await options.getStoredAuth();
        const result = await client.handleCallback(window.location.href, { persist: false, signal });
        if (!result) throw new ClientError("INVALID_AUTHORIZATION", "Authorization callback has no matching pending request");
        if (result.result !== "approved" || !result.authorization) throw new ClientError(result.result === "denied" ? "AUTHORIZATION_DENIED" : "AUTHORIZATION_FAILED", result.errorDescription || "Authorization failed");
        clearCallbackUrl();
        signal.throwIfAborted();
        return result.authorization;
      }, controller.signal);
    },
    async createSession(input, request) {
      const identity = key(), endpoint = base();
      if (!session || session.base !== endpoint || session.key !== identity) session = {
        base: endpoint, key: identity, client: createSessionClient({ apiBase: endpoint, instanceKey: identity, fetch: fetchRemote }),
      };
      return session.client.createSession(input, request);
    },
  };
  function bucket(): BucketRemote {
    const binding = grant, endpoint = base(), provider = getCredential;
    if (!binding || !provider) throw new ClientError("NOT_AUTHORIZED", "Bind bucket authorization first");
    if (binding.instanceId !== key().instanceId) throw new ClientError("IDENTITY_MISMATCH", "Authorization belongs to another instance");
    return createBucketRemote({ apiBase: endpoint, mfid: binding.mfid, bucketId: binding.bucketId, fetch: fetchRemote,
      getCredential: async () => {
        const credential = await provider();
        if (grant !== binding || apiBase !== endpoint || getCredential !== provider) throw new ClientError("AUTHORIZATION_CHANGED", "Remote binding changed during the request");
        return credential;
      },
    });
  }
  const resource: BucketRemote = {
    getCurrent: async (...args) => bucket().getCurrent(...args),
    getVersion: async (...args) => bucket().getVersion(...args),
    getVersionMeta: async (...args) => bucket().getVersionMeta(...args),
    listVersionHistory: async (...args) => bucket().listVersionHistory(...args),
    getPayload: async (...args) => bucket().getPayload(...args),
    commit: async (...args) => bucket().commit(...args),
    getIndex: async (...args) => bucket().getIndex(...args),
    listFeed: async (...args) => bucket().listFeed(...args),
    async *watchFeed(input) { yield* bucket().watchFeed(input); },
  };
  function bind(value: AuthorizationContext, provider?: () => Promise<BearerCredential>): void {
    alive();
    if (!value || typeof value !== "object") throw new ClientError("INVALID_INPUT", "Authorization is required");
    if (value.instanceId !== key().instanceId) throw new ClientError("IDENTITY_MISMATCH", "Authorization belongs to another instance");
    createHttp({ apiBase: value.apiBase, fetch: fetchRemote });
    if (value.resourceId !== `urn:myfield:bucket:${value.bucketId}` || typeof value.mfid !== "string" || !value.mfid
      || !(value.payloadKey instanceof CryptoKey) || value.payloadKey.extractable || value.payloadKey.algorithm.name !== "AES-GCM"
      || !Array.isArray(value.capabilities)) throw new ClientError("INVALID_INPUT", "Invalid bucket authorization context");
    const binding = Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) }) as AuthorizationContext;
    const client = createSessionClient({ apiBase: binding.apiBase, instanceKey: key(), fetch: fetchRemote });
    let credential: BearerCredential | undefined, refreshing: Promise<BearerCredential> | undefined;
    const credentialProvider = provider ?? (() => {
      if (credential && Date.parse(credential.expiresAt) > Date.now() + 30_000) return Promise.resolve(credential);
      refreshing ??= client.createSession({ mfid: binding.mfid, resourceId: binding.resourceId })
        .then(result => { credential = result.credential; return credential; })
        .finally(() => { refreshing = undefined; });
      return refreshing;
    });
    grant = binding; apiBase = binding.apiBase; getCredential = credentialProvider; session = undefined;
  }
  function clear(): void { grant = undefined; apiBase = undefined; getCredential = undefined; session = undefined; }
  const remote: Remote = {
    get authBase() { return authBase; },
    set authBase(value) { authBase = value; explicitAuthBase = true; },
    get apiBase() { return apiBase; },
    get authorization() { return grant ?? null; },
    bind(value) { writable(); bind(value); },
    unbind() { writable(); clear(); },
    auth, bucket: resource,
  };
  localBindings.set(remote, {
    fetch: fetchRemote,
    exchange(apiBase, identity, input) { return createSessionClient({ apiBase, instanceKey: identity, fetch: fetchRemote }).createSession(input); },
    get generation() { return generation; },
    async run(action, expected = generation) {
      alive();
      if (expected !== generation) throw new ClientError("AUTHORIZATION_CHANGED", "Local connection was cancelled");
      if (!managed && grant) throw new ClientError("REMOTE_BOUND", "Unbind external access before using Local authorization");
      const token = {};
      operations.add(token);
      const active = () => expected === generation && operations.has(token);
      try {
        return await action({ active, publish(value, provider) {
          if (!active()) throw new ClientError("AUTHORIZATION_CHANGED", "Local connection was cancelled");
          bind(value, provider);
          managed = true;
        } });
      } finally { operations.delete(token); }
    },
    reset() { generation++; operations.clear(); if (managed) { clear(); managed = false; } },
  });
  authBases.set(remote, () => explicitAuthBase ? authBase : undefined);
  disposers.set(remote, () => { options.authorizationFlow.cancel(new ClientError("INSTANCE_DISPOSED", "Instance has been disposed")); controller.abort(); generation++; operations.clear(); clear(); managed = false; });
  return remote;
}
