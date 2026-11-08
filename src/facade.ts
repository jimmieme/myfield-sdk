import { createAuthorizationFlow, openAuthorizationPopup, hasAuthorizationCallback, clearCallbackUrl, type AuthorizationFlow } from "./auth/flow.ts";
import { createRemote, disposeRemote, localBinding, configuredAuthBase, type Remote, type LocalOperation } from "./remote/client.ts";
import { createBucketRemote } from "./remote/bucket.ts";
import type { AuthorizationContext } from "./auth/client.ts";
import { createAuthStorage, type AuthStorage } from "./auth/storage.ts";
import type { InstanceKey } from "./crypto/instance.ts";
import type { BearerCredential } from "./remote/session.ts";
import { ClientError } from "./errors.ts";
// Local data facade: createInstance / Instance / Bucket.
//
// A bucket is a local-first end-to-end-encrypted object KV. Local CRUD works
// with no account and no network; connect() is the single network/identity
// boundary. `namespace` scopes ALL local persistence (instance keys, auth
// context, sessions, objects, the internal index) and never reaches the
// wire; bucket `id` is the app-local authorization label, while sync uses
// the remote bucket id returned in the grant envelope. `~index` is local
// only; objects carry their app id in `~id` (docs/BUCKET-SPEC.md).

import { BucketClient, type BucketTransportLike, type ChangeSource } from "./bucket/client.ts";
import type { PayloadDoc } from "./bucket/format.ts";
import {
  canonicalizeFieldValue,
  createBucketBinaryValue,
  fieldValueToCanonicalJson,
  type BinaryInput,
  type BinaryOptions,
  type BucketBinaryValue,
} from "./bucket/binary.ts";
import {
  createIndexedDbStorageAdapter,
  createNamespacedMemoryStorageAdapter,
  type StorageAdapter,
} from "./bucket/store.ts";
import { BucketTransport, OfflineError } from "./bucket/transport.ts";
import { createInstanceAuthClient, isValidBucketId, type AuthCallbackResult, type BucketAccess, type InstanceAuthClient } from "./auth/instance.ts";
import { NotConnectedError } from "./errors.ts";
import { randomId } from "./internal/encoding.ts";

const DEFAULT_AUTH_BASE = "https://myfield.one/auth/";
const INDEX_OBJECT_ID = "~index";
const ID_FIELD = "~id";
const DELETED_FIELD = "~deleted";
const RESERVED_PREFIX = "~";

/**
 * Local instance namespace and storage settings.
 * @public
 */
export type CreateInstanceOptions = {
  namespace?: string;
  storage?: "indexeddb" | "memory";
  /** Optional application-owned authorization store; omitted preserves existing storage. */
  authStorage?: AuthStorage;
  /** An existing identity to persist only if this scope has no identity yet. */
  instanceKey?: InstanceKey;
  /** Initial authorization page; connect options may override it. */
  authBase?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * The local bucket connection state.
 * @public
 */
export type BucketState = "disconnected" | "connecting" | "connected";

/**
 * A local object listing entry.
 * @public
 */
export type ListEntry = { id: string; updatedAt: string; deleted?: true };

/**
 * Authorization and automatic sync settings.
 * @public
 */
export type ConnectOptions = {
  authBase?: string;
  autoSync?: boolean;
};

export type { BinaryInput, BinaryOptions, BucketBinaryValue };

/**
 * Local object storage with authorization and encrypted synchronization.
 * @public
 */
export type Bucket = {
  readonly id: string;
  readonly state: BucketState;
  /** Creates a local binary handle without uploading it. */
  binary(input: BinaryInput | BucketBinaryValue, options?: BinaryOptions): BucketBinaryValue;
  /** @deprecated No-op. Storage initializes on the first data operation. */
  ready(): Promise<void>;
  /** Replaces a local object; omitted fields are removed. */
  put(objectId: string, object: Record<string, unknown>): Promise<void>;
  /** Reads a local object, returning null when missing or deleted. */
  get(objectId: string): Promise<Record<string, unknown> | null>;
  /** Updates supplied fields; undefined removes a field. */
  update(objectId: string, fields: Record<string, unknown>): Promise<void>;
  /** Marks a local object deleted for synchronization. */
  delete(objectId: string): Promise<void>;
  /** Lists local index entries, optionally including deleted objects. */
  list(options?: { prefix?: string; includeDeleted?: boolean }): Promise<ListEntry[]>;
  /** Restores saved authorization and handles an authorization callback. */
  resume(): Promise<BucketState>;
  /** @deprecated Use instance.connect(); this compatibility entry returns state on authorization failure. */
  connect(options?: ConnectOptions): Promise<BucketState>;
  /** @deprecated Use instance.disconnect(); local objects remain. */
  disconnect(): Promise<void>;
  /** Runs a synchronization pass when connected. */
  sync(): Promise<void>;
  /** Enables or disables automatic synchronization. */
  setAutoSync(enabled: boolean): void;
  /** Subscribes to connection state; returns an unsubscribe function. */
  on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
  /** Subscribes to local object changes, including applied remote changes; returns an unsubscribe function. */
  on(event: "change", handler: (objectId: string) => void): () => void;
  /** Stops background work and releases bucket resources. */
  dispose(): void;
  /** @internal */
  __bindTestTransport(transport: BucketTransportLike): void;
};

/**
 * Application identity, Local-first bucket and default Remote resources.
 * @public
 */
export type Instance = {
  readonly appId: string;
  readonly namespace: string;
  /** In-memory identity; null until supplied or restored/created by a Local auth operation. */
  readonly instanceKey: InstanceKey | null;
  /** Stable default Local-first handle; access performs no I/O. */
  readonly bucket: Bucket;
  /** Stable default protocol resources; direct use does not open storage. */
  readonly remote: Remote;
  /** Restores saved identity/access and handles startup callbacks without prompting. */
  resume(options?: { bucketId?: string }): Promise<BucketState>;
  /** Stops sync and clears saved authorization; identity and local objects remain. */
  disconnect(options?: { bucketId?: string }): Promise<void>;
  /** Subscribes to default connection status/details; returns an unsubscribe function. */
  on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
  /** Releases owned runtime work and cancels remote requests without deleting data. */
  dispose(): void;
  createBucket(options?: { id?: string }): Bucket;
  /** Reuses connected/saved access; opens authorization only when none is saved. */
  connect(options?: ConnectOptions & { bucketId?: string }): Promise<Authorization>;
  /** Loads saved access and obtains a session without prompting or consuming callback URLs. */
  getSession(options?: { bucketId?: string; forceRefresh?: boolean }): Promise<BearerCredential>;
};

/**
 * Authorized bucket binding; credentials are obtained on demand.
 * @public
 */
export type Authorization = Readonly<AuthorizationContext> & {
  getSession(options?: { forceRefresh?: boolean }): Promise<BearerCredential>;
};

type ConnectionResult = { state: BucketState; error?: unknown };

const bucketRuntime = new WeakMap<Bucket, {
  connect(options?: ConnectOptions): Promise<ConnectionResult>;
  session(options?: { forceRefresh?: boolean }): Promise<BearerCredential>;
  authorization(): Promise<Authorization>;
  remote: Remote;
  auth(): Promise<InstanceAuthClient>;
}>();

/**
 * Creates a local data instance; local operations work before connecting.
 * @public
 */
export function createInstance(appId: string, options?: CreateInstanceOptions): Instance;
/** Creates a local instance with the original namespace-based settings. @public */
export function createInstance(options?: CreateInstanceOptions): Instance;
export function createInstance(input: string | CreateInstanceOptions = {}, supplied: CreateInstanceOptions = {}): Instance {
  const explicit = typeof input === "string";
  const options = explicit ? supplied : input;
  const appId = explicit ? input : options.namespace ?? "default";
  if (explicit && !isValidBucketId(appId)) throw new ClientError("INVALID_INPUT", "Invalid appId");
  const namespace = explicit ? options.namespace ?? appId : normalizeNamespace(options.namespace);
  if (explicit && (typeof namespace !== "string" || !namespace || namespace.length > 128)) throw new ClientError("INVALID_INPUT", "Invalid namespace");
  const storageKind = options.storage || "indexeddb";
  const baseAdapter = storageKind === "memory"
    ? createNamespacedMemoryStorageAdapter(`myfield-sdk:${namespace}`)
    : createIndexedDbStorageAdapter({ dbName: `myfield-sdk:${namespace}` });
  const authAdapter = options.authStorage
    ? prefixedAdapter(createAuthStorage(options.authStorage), `instance-scope:${encodeURIComponent(namespace)}:`)
    : prefixedAdapter(baseAdapter, "auth:");
  let identity = options.instanceKey ?? null;
  let disposed = false;
  const buckets = new Map<string, Bucket>();
  const authorizationFlow = createAuthorizationFlow();
  function createBucket(bucketOptions: { id?: string } = {}): Bucket {
    if (disposed) throw new ClientError("INSTANCE_DISPOSED", "Instance has been disposed");
    const bucketId = bucketOptions.id === undefined ? appId : String(bucketOptions.id).trim();
    if (!isValidBucketId(bucketId)) throw new ClientError("INVALID_INPUT", "Invalid bucketId");
    const existing = buckets.get(bucketId);
    if (existing) return existing;
    const remote = createRemote({ appId, getIdentity: () => identity, authBase: options.authBase, fetch: options.fetch, authorizationFlow, persistentAuth: !!options.authStorage || storageKind !== "memory",
      getStoredAuth: () => bucketRuntime.get(bucket)!.auth() });
    const bucket = createBucketFacade({ namespace, bucketId, dataAdapter: baseAdapter, authAdapter, remote, authorizationFlow, persistentAuth: !!options.authStorage || storageKind !== "memory",
      ...(explicit ? { authAppId: appId } : {}), getIdentity: () => identity, setIdentity: value => {
        if (identity && identity.instanceId !== value.instanceId) throw new ClientError("IDENTITY_MISMATCH", "Stored identity changed; create a new Instance");
        identity = value;
      }, fetch: options.fetch,
      authBase: options.authBase });
    buckets.set(bucketId, bucket);
    return bucket;
  }
  async function typed<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (cause) { if (cause instanceof ClientError) throw cause; throw new ClientError("INSTANCE_ERROR", cause instanceof Error ? cause.message : "Instance operation failed", { cause }); }
  }
  return {
    appId, namespace, createBucket,
    get instanceKey() { return identity; },
    get bucket() { return createBucket(); },
    get remote() { return bucketRuntime.get(createBucket())!.remote; },
    resume: (input = {}) => typed(() => createBucket({ id: input.bucketId }).resume()),
    disconnect: (input = {}) => typed(() => createBucket({ id: input.bucketId }).disconnect()),
    on: (event, handler) => createBucket().on(event, handler),
    dispose() {
      for (const bucket of buckets.values()) { bucket.dispose(); disposeRemote(bucketRuntime.get(bucket)!.remote); }
      authorizationFlow.cancel(new ClientError("INSTANCE_DISPOSED", "Instance has been disposed"));
      disposed = true;
    },
    connect: (connectOptions = {}) => typed(async () => {
      const control = bucketRuntime.get(createBucket({ id: connectOptions.bucketId ?? appId }))!;
      const result = await control.connect(connectOptions);
      if (result.error) throw result.error;
      if (result.state !== "connected") throw new ClientError("AUTHORIZATION_FAILED", "Authorization did not complete");
      return control.authorization();
    }),
    getSession: (sessionOptions = {}) => typed(() => bucketRuntime.get(createBucket({ id: sessionOptions.bucketId ?? appId }))!.session(sessionOptions)),
  };
}

// ---------------------------------------------------------------------------

type BucketDeps = {
  namespace: string;
  bucketId: string;
  dataAdapter: StorageAdapter;
  authAdapter: StorageAdapter;
  authAppId?: string;
  getIdentity(): InstanceKey | null;
  setIdentity(key: InstanceKey): void;
  remote: Remote;
  authorizationFlow: AuthorizationFlow;
  persistentAuth: boolean;
  fetch?: typeof globalThis.fetch;
  authBase?: string;
};

function createBucketFacade(deps: BucketDeps): Bucket {
  const { bucketId, dataAdapter, authAdapter } = deps;
  const endpointsKey = `meta:${bucketId}:endpoints`;
  const actorKey = `meta:actor`;

  let state: BucketState = "disconnected";
  let client: BucketClient | null = null;
  let clientInit: Promise<BucketClient> | null = null;
  let liveTransport: BucketTransportLike | null = null;
  let liveWireId: ((appObjectId: string) => Promise<string>) | null = null;
  let autoSync = true;
  let syncIntervalMs: number | undefined;
  let disposed = false;

  // Browser auth machinery (lazy; never touched by the test seam path).
  let authClient: InstanceAuthClient | null = null;
  let authPageAddress = "";
  let authorizationController: AbortController | null = null;
  let pendingConnect: { resolve: (result: ConnectionResult) => void; operation: LocalOperation } | null = null;
  let pendingConnectDone: Promise<ConnectionResult> | null = null;
  let connectionError: unknown = null;

  const listeners = { state: new Set<(s: BucketState, d?: string) => void>(), change: new Set<(id: string) => void>() };

  function notify<T extends unknown[]>(handlers: Set<(...args: T) => void>, ...args: T): void {
    for (const handler of [...handlers]) {
      try { void Promise.resolve(handler(...args)).catch(() => {}); } catch {}
    }
  }

  function emitState(next: BucketState, detail?: string): void {
    if (state !== next) {
      state = next;
      notify(listeners.state, next, detail);
    } else if (detail) {
      notify(listeners.state, next, detail);
    }
  }

  function emitChange(objectId: string): void {
    if (objectId.startsWith(RESERVED_PREFIX)) return;
    notify(listeners.change, objectId);
  }

  function settlePendingConnect(operation?: LocalOperation): void {
    if (!pendingConnect || (operation && pendingConnect.operation !== operation)) return;
    const settle = pendingConnect;
    pendingConnect = null;
    settle.resolve({ state, ...(connectionError ? { error: connectionError } : {}) });
  }

  function failConnect(error: unknown, operation = pendingConnect?.operation): void {
    if (operation && !operation.active()) return;
    connectionError = error;
    emitState(liveTransport ? "connected" : "disconnected", formatError(error));
    settlePendingConnect(operation);
  }

  function ensureClient(): Promise<BucketClient> {
    if (disposed) return Promise.reject(new ClientError("INSTANCE_DISPOSED", "Bucket has been disposed"));
    if (clientInit) return clientInit;
    clientInit = (async () => {
      let actorId = await dataAdapter.get<string>(actorKey);
      if (typeof actorId !== "string" || !actorId) {
        actorId = randomId("actor");
        await dataAdapter.set(actorKey, actorId);
      }
      client = new BucketClient({
        transport: {
          pullHead(wireObjectId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.pullHead(wireObjectId);
          },
          pullPayload(wireObjectId, versionId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.pullPayload(wireObjectId, versionId);
          },
          push(wireObjectId, plaintext, expectedHeadVersionId) {
            if (!liveTransport) return Promise.reject(new OfflineError());
            return liveTransport.push(wireObjectId, plaintext, expectedHeadVersionId);
          },
          listHeads() {
            if (!liveTransport?.listHeads) return Promise.reject(new OfflineError());
            return liveTransport.listHeads();
          },
        },
        storage: dataAdapter,
        actorId,
        localOnlyObjectIds: [INDEX_OBJECT_ID],
        validateRemote: assertRemoteObjectId,
        wireObjectId: (appObjectId) => {
          if (!liveWireId) return Promise.reject(new OfflineError());
          return liveWireId(appObjectId);
        },
        storagePrefix: `data:${bucketId}`,
        onChange: onClientChange,
        onSyncError: (objectId, error) => {
          if (error instanceof OfflineError) return;
          // Retryable sync failures surface as state detail without a state
          // change; local data is never affected.
          emitState(state, `sync error${objectId ? ` (${objectId})` : ""}: ${formatError(error)}`);
        },
      });
      return client;
    })();
    return clientInit;
  }

  function assertRemoteObjectId(objectId: string, doc: PayloadDoc): void {
    if (objectId.startsWith(RESERVED_PREFIX) || doc.t !== "lww-map") return;
    const remoteId = doc.fields[ID_FIELD]?.v;
    if (remoteId !== undefined && remoteId !== objectId) throw new Error(`object id mismatch for ${objectId}`);
  }

  // Refresh the index before emitting, so a change handler's list() sees it.
  const pendingIndexRefreshes = new Set<Promise<void>>();
  function onClientChange(objectId: string, source: ChangeSource): void {
    if (objectId.startsWith(RESERVED_PREFIX)) return;
    if (source === "local") {
      emitChange(objectId);
      return;
    }
    const refresh = refreshIndexEntry(objectId)
      .catch((error) => emitState(state, `index update failed (${objectId}): ${formatError(error)}`))
      .finally(() => {
        pendingIndexRefreshes.delete(refresh);
        emitChange(objectId);
      });
    pendingIndexRefreshes.add(refresh);
  }

  async function refreshIndexEntry(objectId: string): Promise<void> {
    const c = await ensureClient();
    const raw = await c.getFields(objectId);
    const latest = await c.lastModified(objectId);
    await upsertIndexEntry(objectId, raw?.[DELETED_FIELD] === true, latest ?? Date.now());
  }

  // ---- local object API ---------------------------------------------------

  function assertObjectId(objectId: string): void {
    if (typeof objectId !== "string" || !objectId) throw new Error("objectId must be a non-empty string");
    if (objectId.startsWith(RESERVED_PREFIX)) throw new Error(`object ids starting with "${RESERVED_PREFIX}" are reserved`);
  }

  function assertFieldNames(fields: Record<string, unknown>): void {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be a plain object");
    for (const name of Object.keys(fields)) {
      if (name.startsWith(RESERVED_PREFIX)) throw new Error(`field names starting with "${RESERVED_PREFIX}" are reserved`);
    }
  }

  // `rev` keeps two writes in one millisecond distinct.
  let lastIndexRev = 0;
  async function upsertIndexEntry(objectId: string, deleted: boolean, updatedAtMs = Date.now()): Promise<void> {
    const c = await ensureClient();
    lastIndexRev = Math.max(lastIndexRev + 1, Date.now());
    await c.setFields(INDEX_OBJECT_ID, {
      [objectId]: {
        updatedAt: new Date(updatedAtMs).toISOString(),
        rev: lastIndexRev,
        ...(deleted ? { deleted: true } : {}),
      },
    });
  }

  function publicView(raw: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(raw).filter(([name]) => !name.startsWith(RESERVED_PREFIX)));
  }

  // Fields whose JSON value is unchanged keep their existing LWW
  // timestamp/source (API.md): re-stamping unchanged fields would let a
  // device that re-saves whole objects steamroll other devices' concurrent
  // field edits.
  async function dropUnchanged(updates: Record<string, unknown>, known: Record<string, unknown>): Promise<Record<string, unknown>> {
    const changed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(updates)) {
      if (value === undefined) {
        if (name in known) changed[name] = undefined;
        continue;
      }
      const canonicalValue = await canonicalizeFieldValue(value);
      if (name in known && JSON.stringify(fieldValueToCanonicalJson(await canonicalizeFieldValue(known[name]))) === JSON.stringify(fieldValueToCanonicalJson(canonicalValue))) continue;
      changed[name] = value;
    }
    return changed;
  }

  function withObjectId(updates: Record<string, unknown>, objectId: string, known: Record<string, unknown>): Record<string, unknown> {
    return known[ID_FIELD] === objectId ? updates : { ...updates, [ID_FIELD]: objectId };
  }

  async function put(objectId: string, object: Record<string, unknown>): Promise<void> {
    assertObjectId(objectId);
    assertFieldNames(object);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { ...object };
    for (const name of Object.keys(known)) {
      if (!(name in object) && name !== ID_FIELD) updates[name] = undefined; // deletes locally known omitted fields (incl. a live ~deleted marker)
    }
    const changed = await dropUnchanged(updates, known);
    if (Object.keys(changed).length === 0) return; // full no-op: do not advance LWW state or the index entry
    await c.setFields(objectId, withObjectId(changed, objectId, known));
    await upsertIndexEntry(objectId, false);
  }

  async function update(objectId: string, fields: Record<string, unknown>): Promise<void> {
    assertObjectId(objectId);
    assertFieldNames(fields);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { ...fields };
    if (DELETED_FIELD in known) updates[DELETED_FIELD] = undefined; // update recreates a deleted object
    const changed = await dropUnchanged(updates, known);
    if (Object.keys(changed).length === 0) return;
    await c.setFields(objectId, withObjectId(changed, objectId, known));
    await upsertIndexEntry(objectId, false);
  }

  async function getObject(objectId: string): Promise<Record<string, unknown> | null> {
    assertObjectId(objectId);
    const c = await ensureClient();
    const raw = await c.getFields(objectId);
    if (!raw) return null;
    if (raw[DELETED_FIELD]) return null;
    const view = publicView(raw);
    return Object.keys(view).length === 0 && !(await hasIndexEntry(objectId)) ? null : view;
  }

  async function hasIndexEntry(objectId: string): Promise<boolean> {
    const c = await ensureClient();
    const index = (await c.getFields(INDEX_OBJECT_ID)) || {};
    return objectId in index;
  }

  async function deleteObject(objectId: string): Promise<void> {
    assertObjectId(objectId);
    const c = await ensureClient();
    const known = (await c.getFields(objectId)) || {};
    const updates: Record<string, unknown> = { [DELETED_FIELD]: true };
    for (const name of Object.keys(known)) {
      if (!name.startsWith(RESERVED_PREFIX)) updates[name] = undefined;
    }
    await c.setFields(objectId, withObjectId(updates, objectId, known));
    await upsertIndexEntry(objectId, true);
  }

  async function list(options?: { prefix?: string; includeDeleted?: boolean }): Promise<ListEntry[]> {
    const c = await ensureClient();
    const index = (await c.getFields(INDEX_OBJECT_ID)) || {};
    const rows: ListEntry[] = [];
    for (const [objectId, value] of Object.entries(index)) {
      if (objectId.startsWith(RESERVED_PREFIX)) continue;
      if (options?.prefix && !objectId.startsWith(options.prefix)) continue;
      const entry = value as { updatedAt?: unknown; deleted?: unknown } | null;
      if (!entry || typeof entry.updatedAt !== "string") continue;
      const deleted = entry.deleted === true;
      if (deleted && !options?.includeDeleted) continue;
      rows.push({ id: objectId, updatedAt: entry.updatedAt, ...(deleted ? { deleted: true as const } : {}) });
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return rows;
  }

  // ---- sync ---------------------------------------------------------------

  async function sync(): Promise<void> {
    if (!liveTransport) throw new NotConnectedError();
    await runSyncPass();
  }

  async function runSyncPass(): Promise<void> {
    const c = await ensureClient();
    const wireId = liveWireId;
    if (!wireId) throw new OfflineError();
    // 0.9.0 compatibility: skip the remote ~index, but use it to resolve objects without ~id.
    let legacyIndex: Record<string, unknown> | null | undefined;
    await c.syncPass({
      skipWireIds: [await wireId(INDEX_OBJECT_ID)],
      resolveUnknown: async (wireObjectId, versionId) => {
        const doc = await c.pullDoc(wireObjectId, versionId);
        if (!doc || doc.t !== "lww-map") return null;
        const id = doc.fields[ID_FIELD]?.v;
        if (typeof id === "string") return id;
        if (legacyIndex === undefined) {
          const legacy = await c.pullRemoteDoc(INDEX_OBJECT_ID);
          legacyIndex = legacy?.t === "lww-map" ? legacy.fields : null;
        }
        for (const candidate of Object.keys(legacyIndex || {})) {
          if (!candidate.startsWith(RESERVED_PREFIX) && (await wireId(candidate)) === wireObjectId) return candidate;
        }
        return null;
      },
    });
    await writeMissingObjectIds(c);
    await Promise.all(pendingIndexRefreshes);
  }

  // 0.9.0 compatibility: add ~id to objects written without it.
  async function writeMissingObjectIds(c: BucketClient): Promise<void> {
    const upgraded: string[] = [];
    for (const id of await c.knownObjectIds()) {
      if (id.startsWith(RESERVED_PREFIX)) continue;
      const raw = await c.getFields(id);
      if (!raw || raw[ID_FIELD] === id) continue;
      await c.setFields(id, { [ID_FIELD]: id });
      upgraded.push(id);
    }
    for (const id of upgraded) await c.flush(id);
  }

  function startAutoSync(): void {
    if (!autoSync || !client) return;
    client.start({ run: runSyncPass, ...(syncIntervalMs !== undefined ? { intervalMs: syncIntervalMs } : {}) });
  }

  // ---- connection (browser) ----------------------------------------------

  async function readStoredEndpoints(): Promise<{ authBase: string }> {
    const stored = await dataAdapter.get<{ authBase?: string }>(endpointsKey);
    return { authBase: configuredAuthBase(deps.remote) ?? stored?.authBase ?? DEFAULT_AUTH_BASE };
  }

  async function ensureAuthClients(endpoints: { authBase: string }): Promise<InstanceAuthClient> {
    const authPageUrl = normalizeAuthBase(endpoints.authBase);
    if (authClient && authPageAddress === authPageUrl) return authClient;
    authPageAddress = authPageUrl;
    deps.remote.authBase = authPageUrl;
    const browser = typeof window !== "undefined";
    if (!browser && !deps.authAppId) throw new Error("connect()/resume() require a browser environment");
    const origin = browser ? window.location.origin : "https://sdk.invalid";
    const baseOptions = {
      appId: deps.authAppId ?? new URL(origin).hostname,
      instanceKey: deps.getIdentity() ?? undefined,
      fetchImpl: deps.fetch,
      redirectUri: browser ? origin + window.location.pathname : origin + "/",
      origin,
      storage: authAdapter,
      onIdentity: deps.setIdentity,
      createSession: async (apiBase: string, identity: InstanceKey, input: { mfid: string; resourceId: string }) => {
        deps.setIdentity(identity);
        return localBinding(deps.remote).exchange(apiBase, identity, input);
      },
    };
    authClient = createInstanceAuthClient({
      ...baseOptions,
      authPageUrl: addCallbackTransport(authPageUrl, "same-tab"),
    });
    return authClient;
  }

  async function handleCallbackUrl(callbackUrl: string, operation: LocalOperation, signal?: AbortSignal): Promise<AuthCallbackResult | null> {
    try {
      const auth = await ensureAuthClients(await readStoredEndpoints());
      if (!operation.active()) return null;
      const callback = await auth.handleCallback(callbackUrl, { signal });
      if (!operation.active()) return null;
      if (!callback) throw new ClientError("INVALID_AUTHORIZATION", "Authorization callback did not match the pending request");
      if (callback.result === "approved") {
        await establish(operation, { forceRefresh: true }, signal);
      } else {
        failConnect(new ClientError(callback.result === "denied" ? "AUTHORIZATION_DENIED" : "AUTHORIZATION_FAILED",
          callback.errorDescription || callback.error || callback.result), operation);
      }
      return callback;
    } catch (error) {
      failConnect(error, operation);
      return null;
    }
  }

  function publishRemote(auth: InstanceAuthClient, access: BucketAccess, operation: LocalOperation): void {
    const apiBase = access.resourceApiUrl!.replace(/\/+$/, "").replace(/\/v1\/api\/sync$/, "");
    operation.publish({ mfid: access.mfid, instanceId: access.instanceId, bucketId: access.bucketId,
      resourceId: access.resourceId, apiBase, keyId: access.keys.keyId, payloadKey: access.keys.payloadKey,
      capabilities: [...access.capabilities] }, async () => {
        const credential = await auth.getSession(bucketId);
        if (credential.carrier !== "bearer") throw new ClientError("UNSUPPORTED_CREDENTIAL", "Bearer session required");
        return credential;
      });
  }

  async function prepareTransport(auth: InstanceAuthClient, sessionOptions: { forceRefresh?: boolean } = {}) {
    const c = await ensureClient();
    const access = await auth.getBucketAccess(bucketId);
    if (!access.resourceApiUrl) throw new ClientError("INVALID_RESPONSE", "Authorization is missing its resource URL");
    await auth.getSession(bucketId, sessionOptions);
    const transport = new BucketTransport({
      remote: createBucketRemote({ apiBase: access.resourceApiUrl.replace(/\/+$/, "").replace(/\/v1\/api\/sync$/, ""),
        mfid: access.mfid, bucketId: access.bucketId, fetch: localBinding(deps.remote).fetch, schema: "legacy",
        getCredential: async () => {
          const credential = await auth.getSession(bucketId);
          if (credential.carrier !== "bearer") throw new ClientError("UNSUPPORTED_CREDENTIAL", "Bearer session required");
          return credential;
        } }),
      apiBase: access.resourceApiUrl,
      mfid: access.mfid,
      keys: access.keys,
      sessionProvider: {
        getSession: (sessionOpts) => auth.getSession(bucketId, sessionOpts),
        onUnauthorized: () => {
          if (liveTransport !== transport) return;
          // Retain saved access; explicit disconnect/connect is required to reauthorize.
          liveTransport = null;
          liveWireId = null;
          c.stop();
          emitState("disconnected", "unauthorized");
        },
      },
    });
    await verifyConnectedTransport(transport, access.keys.wireObjectId);
    return { transport, wireObjectId: access.keys.wireObjectId, auth, access };
  }

  function activateTransport(prepared: Awaited<ReturnType<typeof prepareTransport>>, operation: LocalOperation): void {
    publishRemote(prepared.auth, prepared.access, operation);
    client?.stop();
    liveTransport = prepared.transport;
    liveWireId = prepared.wireObjectId;
    startAutoSync();
    emitState("connected");
  }

  async function establish(operation: LocalOperation, sessionOptions: { forceRefresh?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    if (!operation.active()) return;
    emitState("connecting");
    try {
      const auth = await ensureAuthClients(await readStoredEndpoints());
      const prepared = await prepareTransport(auth, sessionOptions);
      signal?.throwIfAborted();
      activateTransport(prepared, operation);
    } catch (error) {
      if (!operation.active()) return;
      connectionError = error;
      emitState(liveTransport ? "connected" : "disconnected", formatError(error));
    } finally {
      settlePendingConnect(operation);
    }
  }

  async function verifyConnectedTransport(transport: BucketTransport, wireObjectId: (appObjectId: string) => Promise<string>): Promise<void> {
    await transport.pullHead(await wireObjectId(INDEX_OBJECT_ID));
  }

  async function handleStartupCallback(operation: LocalOperation): Promise<boolean> {
    const href = window.location.href;
    if (!hasAuthorizationCallback(href)) return false;
    const callback = await handleCallbackUrl(href, operation);
    if (callback) clearCallbackUrl();
    return !!callback;
  }

  async function resumeBucket(): Promise<BucketState> {
    if (disposed) throw new Error("disposed");
    if (typeof window === "undefined" || state !== "disconnected") return state;
    const binding = localBinding(deps.remote), generation = binding.generation;
    const auth = await ensureAuthClients(await readStoredEndpoints());
    const url = new URL(window.location.href);
    const callback = hasAuthorizationCallback(url.href);
    if (!callback && !await auth.getContext(bucketId)) return state;
    return binding.run(async operation => {
      await ensureClient();
      if (!await handleStartupCallback(operation)) await establish(operation);
      return state;
    }, generation);
  }

  function connectBucket(options?: ConnectOptions): Promise<ConnectionResult> {
    if (disposed) return Promise.reject(new ClientError("INSTANCE_DISPOSED", "Bucket has been disposed"));
    if (state === "connected") return Promise.resolve({ state });
    if (pendingConnectDone) return pendingConnectDone;
    if (typeof window === "undefined") return Promise.reject(new ClientError("BROWSER_REQUIRED", "Interactive authorization requires a browser"));
    connectionError = null;
    const done = localBinding(deps.remote).run(operation => new Promise<ConnectionResult>(resolve => {
      pendingConnect = { resolve, operation };
      void beginConnect(operation, options).catch(error => {
        if (!operation.active()) return;
        failConnect(error, operation);
      });
    })).catch(error => ({ state, error })).finally(() => {
      if (pendingConnectDone === done) pendingConnectDone = null;
    });
    pendingConnectDone = done;
    return done;
  }

  async function beginConnect(operation: LocalOperation, options?: ConnectOptions): Promise<void> {
    if (options?.autoSync !== undefined) autoSync = options.autoSync;
    if (options?.authBase) {
      const authBase = normalizeAuthBase(options.authBase);
      deps.remote.authBase = authBase;
      await dataAdapter.set(endpointsKey, { authBase });
      authClient = null;
    }
    const auth = await ensureAuthClients(await readStoredEndpoints());
    if (!operation.active()) return;
    await handleStartupCallback(operation);
    if (!pendingConnect || !operation.active()) return;
    const context = await auth.getContext(bucketId);
    if (!pendingConnect || !operation.active()) return;
    if (context) {
      await establish(operation);
      return;
    }
    emitState("connecting");
    const controller = new AbortController();
    authorizationController = controller;
    try {
      await deps.authorizationFlow.run(async signal => {
        let request: Awaited<ReturnType<InstanceAuthClient["prepareAuthorization"]>> | undefined;
        let redirected = false;
        const prepare = async () => {
          request = await auth.prepareAuthorization({ bucketId }, signal);
          deps.authorizationFlow.identify(signal, request.requestId);
          return request;
        };
        const redirect = async () => {
          if (!deps.persistentAuth) throw new ClientError("AUTH_STORAGE_REQUIRED", "Same-tab authorization requires persistent auth storage");
          const pending = request ?? await prepare();
          signal.throwIfAborted();
          window.location.href = pending.url;
          redirected = true;
          await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        };
        try {
          if (shouldUseSameTabAuth()) await redirect();
          else {
            try {
              await openAuthorizationPopup({ request: prepare, signal,
                callback: (url, _, signal) => handleCallbackUrl(url, operation, signal) });
            } catch (error) {
              if (error instanceof ClientError && error.code === "AUTHORIZATION_BLOCKED") await redirect();
              else throw error;
            }
          }
        } finally {
          if (request && (!redirected || signal.reason?.code !== "INSTANCE_DISPOSED")) await auth.cancelAuthorization(request.requestId);
        }
      }, controller.signal);
    } finally { if (authorizationController === controller) authorizationController = null; }
  }

  async function session(options?: { forceRefresh?: boolean }): Promise<BearerCredential> {
    if (disposed) throw new ClientError("INSTANCE_DISPOSED", "Bucket has been disposed");
    return localBinding(deps.remote).run(async operation => {
      const auth = await ensureAuthClients(await readStoredEndpoints());
      const access = await auth.getBucketAccess(bucketId);
      if (!access.resourceApiUrl) throw new ClientError("INVALID_RESPONSE", "Authorization is missing its resource URL");
      const credential = await auth.getSession(bucketId, options);
      if (credential.carrier !== "bearer") throw new ClientError("UNSUPPORTED_CREDENTIAL", "Bearer session required");
      publishRemote(auth, access, operation);
      return credential;
    });
  }

  async function authorization(): Promise<Authorization> {
    const auth = await ensureAuthClients(await readStoredEndpoints());
    const access = await auth.getBucketAccess(bucketId);
    if (!access.resourceApiUrl) throw new ClientError("INVALID_RESPONSE", "Authorization is missing its resource URL");
    return {
      mfid: access.mfid, instanceId: access.instanceId, resourceId: access.resourceId,
      bucketId: access.bucketId, keyId: access.keys.keyId, payloadKey: access.keys.payloadKey, capabilities: [...access.capabilities],
      apiBase: access.resourceApiUrl.replace(/\/+$/, "").replace(/\/v1\/api\/sync$/, ""),
      async getSession(options) {
        try {
          const current = await auth.getBucketAccess(bucketId);
          if (current.mfid !== access.mfid || current.instanceId !== access.instanceId || current.resourceId !== access.resourceId || current.grantRecordId !== access.grantRecordId || current.resourceApiUrl !== access.resourceApiUrl) throw new ClientError("AUTHORIZATION_CHANGED", "Authorization binding changed");
          return await session(options);
        } catch (cause) {
          if (cause instanceof ClientError) throw cause;
          throw new ClientError("INSTANCE_ERROR", cause instanceof Error ? cause.message : "Session unavailable", { cause });
        }
      },
    };
  }

  // ---- public object ------------------------------------------------------

  const publicBucket: Bucket = {
    id: bucketId,
    get state() {
      return state;
    },
    binary(input, options) {
      return createBucketBinaryValue(input, options);
    },
    async ready() {},
    put,
    get: getObject,
    update,
    delete: deleteObject,
    list,
    resume: resumeBucket,
    connect: async options => (await connectBucket(options)).state,
    async disconnect() {
      authorizationController?.abort(new ClientError("AUTHORIZATION_CANCELLED", "Authorization disconnected"));
      localBinding(deps.remote).reset();
      liveTransport = null;
      liveWireId = null;
      client?.stop();
      const auth = await ensureAuthClients(await readStoredEndpoints());
      await auth.clearContext(bucketId);
      emitState("disconnected");
      settlePendingConnect();
    },
    async sync() {
      await sync();
    },
    setAutoSync(enabled) {
      autoSync = enabled;
      if (!client) return;
      if (enabled && liveTransport) startAutoSync();
      if (!enabled) client.stop();
    },
    on(event: "state" | "change", handler: (...args: never[]) => void): () => void {
      const set = listeners[event] as Set<(...args: unknown[]) => void>;
      set.add(handler as (...args: unknown[]) => void);
      return () => set.delete(handler as (...args: unknown[]) => void);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveTransport = null; liveWireId = null;
      client?.dispose();
      authorizationController?.abort(new ClientError("INSTANCE_DISPOSED", "Instance has been disposed"));
      if (pendingConnect) failConnect(new ClientError("INSTANCE_DISPOSED", "Instance has been disposed"));
      localBinding(deps.remote).reset();
      listeners.state.clear(); listeners.change.clear();
      },
    __bindTestTransport(transport) {
      liveTransport = transport;
      liveWireId = async (appObjectId) => appObjectId;
      emitState("connected");
    },
  };
  bucketRuntime.set(publicBucket, { connect: connectBucket, session, authorization, remote: deps.remote, auth: async () => ensureAuthClients({ authBase: deps.remote.authBase }) });
  return publicBucket;
}

function normalizeNamespace(value: string | undefined): string {
  const namespace = value === undefined ? "default" : String(value).trim();
  if (!namespace) throw new Error("namespace is required");
  if (!/^[a-z0-9]{1,32}$/.test(namespace)) {
    throw new Error("namespace must use lowercase letters and digits only (a-z0-9, max 32)");
  }
  return namespace;
}

function prefixedAdapter(adapter: StorageAdapter, prefix: string): StorageAdapter {
  return {
    get: (key) => adapter.get(`${prefix}${key}`),
    set: (key, value) => adapter.set(`${prefix}${key}`, value),
    ...(adapter.add ? { add: (key: string, value: unknown) => adapter.add!(`${prefix}${key}`, value) } : {}),
    remove: (key) => adapter.remove(`${prefix}${key}`),
    keys: async (keyPrefix) => (await adapter.keys(`${prefix}${keyPrefix}`)).map((key) => key.slice(prefix.length)),
  };
}

function addCallbackTransport(url: string, transport: "same-tab" | "popup"): string {
  const parsed = new URL(url, typeof window === "undefined" ? "https://localhost/" : window.location.href);
  parsed.searchParams.set("callbackTransport", transport);
  return parsed.toString();
}

function normalizeAuthBase(value: string): string {
  const parsed = new URL(String(value || DEFAULT_AUTH_BASE), typeof window === "undefined" ? DEFAULT_AUTH_BASE : window.location.href);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/auth") ? `${pathname}/` : `${pathname}/auth/`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}


function shouldUseSameTabAuth(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
