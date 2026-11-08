/**
 * An HTTP(S) service origin and optional fetch implementation.
 * @public
 */
export declare type ApiOptions = {
    apiBase: string;
    fetch?: typeof globalThis.fetch;
};

/**
 * Authorized bucket binding; credentials are obtained on demand.
 * @public
 */
export declare type Authorization = Readonly<AuthorizationContext> & {
    getSession(options?: {
        forceRefresh?: boolean;
    }): Promise<BearerCredential>;
};

/** Authorization flow independent of durable storage and bucket HTTP operations. @public */
export declare interface AuthorizationClient {
    /** Builds a same-tab request without navigating or persisting anything. */
    createRequest(options?: {
        bucketId?: string;
    }): AuthorizationRequest;
    /** Validates/decrypts a callback against retained request state; performs no writes. */
    handleCallback(url: string, request: AuthorizationRequest): Promise<AuthorizationContext>;
    /** Opens a popup from a user action and returns the verified context/key; never persists it. */
    authorize(options?: {
        bucketId?: string;
        signal?: AbortSignal;
    }): Promise<AuthorizationContext>;
}

/** Instance identity and authorization page; no storage or session creation. @public */
export declare type AuthorizationClientOptions = {
    appId: string;
    instanceKey: InstanceKey;
    authBase?: string;
    redirectUri?: string;
};

/** Cloneable authorization context and a non-extractable bucket data key. @public */
export declare type AuthorizationContext = {
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
export declare type AuthorizationRequest = {
    url: string;
    requestId: string;
    state: string;
    resourceId: string;
    instanceId: string;
    redirectUri: string;
    createdAt: string;
};

/** Explicit storage for cloneable identity, pending request and authorization records. @public */
export declare interface AuthorizationStorage {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    add(key: string, value: unknown): Promise<boolean>;
    remove(key: string): Promise<void>;
    keys(prefix: string): Promise<string[]>;
}

/** Application-owned database and out-of-line key store for authorization records. @public */
export declare type AuthStorage = {
    database: IDBDatabase;
    store: string;
};

/**
 * A bearer credential and its server-provided expiration.
 * @public
 */
export declare type BearerCredential = {
    carrier: "bearer";
    token: string;
    expiresAt: string;
    sessionKind?: "instance";
};

/**
 * Binary input accepted by a local bucket.
 * @public
 */
export declare type BinaryInput = Blob | ArrayBuffer | Uint8Array;

/**
 * Application-provided binary metadata.
 * @public
 */
export declare type BinaryOptions = {
    mimeType?: string;
    name?: string;
    lastModified?: number;
};

/**
 * Local object storage with authorization and encrypted synchronization.
 * @public
 */
export declare type Bucket = {
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
    list(options?: {
        prefix?: string;
        includeDeleted?: boolean;
    }): Promise<ListEntry[]>;
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
};

/**
 * A local binary value handle with lazy body access.
 * @public
 */
export declare type BucketBinaryValue = {
    readonly kind: "binary";
    readonly size: number;
    readonly mimeType?: string;
    readonly name?: string;
    readonly lastModified?: number;
    blob(): Promise<Blob>;
    arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * Current object heads and the cursor for subsequent feed catch-up.
 * @public
 */
export declare type BucketIndex = {
    bucketId: string;
    feedCursor: string | null;
    hasMoreFeed: boolean;
    objects: FeedHint[];
    [field: string]: unknown;
};

/**
 * A single-bucket protocol client without persistence, crypto or automatic retries.
 * @public
 */
export declare interface BucketRemote {
    /** Returns null for a missing object. Optional have requests ancestry evidence. */
    getCurrent(objectId: string, options?: RequestOptions & {
        have?: string | null;
    }): Promise<CurrentVersion | null>;
    /** Reads fixed-version metadata and a streaming payload using two parallel requests. */
    getVersion(objectId: string, versionId: string, options?: RequestOptions): Promise<ObjectVersion>;
    /** Reads fixed-version metadata; a missing version throws. */
    getVersionMeta(objectId: string, versionId: string, options?: RequestOptions): Promise<VersionMeta>;
    /** Lists committed versions, not an ancestor graph; pagination is explicit. */
    listVersionHistory(objectId: string, versionId: string, options?: PageOptions): Promise<VersionHistory>;
    /** Returns a native Response; the caller consumes or cancels its body. */
    getPayload(objectId: string, versionId: string, options?: RequestOptions): Promise<Response>;
    /** Submits fixed bytes and a CAS condition; content semantics belong to its object encoding. */
    commit(input: CommitInput, options?: RequestOptions & {
        schema?: CommitSchema;
    }): Promise<CommitResult>;
    /** Reads current heads and a nullable feed cursor; absence is not deletion. */
    getIndex(options?: RequestOptions): Promise<BucketIndex>;
    /** Reads one durable feed page; null cursor starts at the beginning. */
    listFeed(options?: PageOptions): Promise<FeedPage>;
    /** Opens one connection on iteration; yields ready before change hints, with no reconnect. */
    watchFeed(options?: RequestOptions): AsyncGenerator<FeedEvent>;
}

/**
 * Connection settings for one remote bucket.
 * @public
 */
export declare type BucketRemoteOptions = ApiOptions & {
    mfid: string;
    bucketId: string;
    getCredential(): {
        token: string;
    } | Promise<{
        token: string;
    }>;
    /** Defaults to raw current-format upload. */
    schema?: CommitSchema;
};

/**
 * The local bucket connection state.
 * @public
 */
export declare type BucketState = "disconnected" | "connecting" | "connected";

/**
 * An HTTP, network, invalid-input or invalid-response failure.
 * @public
 */
export declare class ClientError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly requestId?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly maxBytes?: number;
    constructor(code: string, message: string, options?: ClientErrorOptions);
}

/**
 * HTTP and retry hints; retryability does not determine commit outcome.
 * @public
 */
export declare type ClientErrorOptions = {
    status?: number;
    requestId?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    maxBytes?: number;
    cause?: unknown;
};

/**
 * A fixed version and ciphertext; explicit null CAS creates an object.
 * @public
 */
export declare type CommitInput = {
    meta: VersionMeta;
    payload: Blob | Uint8Array;
    expectedHeadVersionId: string | null;
    headState?: {
        headVersionId: string;
        historyMap: Record<string, string[]>;
        fieldSources: Record<string, string>;
    };
};

/**
 * A write acknowledgement or normal CAS rejection; unknown results throw.
 * @public
 */
export declare type CommitResult = {
    ok: true;
} | {
    ok: false;
    reason: "version-mismatch" | "conflict";
};

/** Request encoding for the same commit endpoint; payload encryption stays with callers. @public */
export declare type CommitSchema = "current" | "legacy" | {
    encode(input: CommitInput): {
        body: Blob | Uint8Array | FormData;
        headers?: HeadersInit;
    };
};

/**
 * Authorization and automatic sync settings.
 * @public
 */
export declare type ConnectOptions = {
    authBase?: string;
    autoSync?: boolean;
};

/** Binds an existing identity to authorization requests and callback processing. @public */
export declare function createAuthorizationClient(options: AuthorizationClientOptions): AuthorizationClient;

/** Uses an existing IndexedDB store; no records are saved until explicitly requested. @public */
export declare function createAuthorizationStorage(options: AuthStorage): AuthorizationStorage;

/**
 * Creates a protocol client scoped to one remote bucket ID.
 * @public
 */
export declare function createBucketRemote(options: BucketRemoteOptions): BucketRemote;

/**
 * Creates a local data instance; local operations work before connecting.
 * @public
 */
export declare function createInstance(appId: string, options?: CreateInstanceOptions): Instance;

/** Creates a local instance with the original namespace-based settings. @public */
export declare function createInstance(options?: CreateInstanceOptions): Instance;

/** Creates non-extractable instance keys without storage or network access. @public */
export declare function createInstanceKey(): Promise<InstanceKey>;

/**
 * Local instance namespace and storage settings.
 * @public
 */
export declare type CreateInstanceOptions = {
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

/** Creates a session client with fixed instance keys and service origin. @public */
export declare function createSessionClient(options: SessionClientOptions): SessionClient;

/**
 * Current head with optional ancestry evidence requested by have.
 * @public
 */
export declare type CurrentVersion = {
    versionId: string;
    headVersionMeta: VersionMeta;
    /** Non-empty proves ancestry; [] is no stored proof; null is incomplete or bounded evidence. */
    history?: string[] | null;
    [field: string]: unknown;
};

/**
 * Readiness followed by change hints; ignore unrecognized future event types.
 * @public
 */
export declare type FeedEvent = {
    type: "ready";
} | ({
    type: "change";
} & FeedHint);

/**
 * A prompt to check the durable feed, not the changed object contents.
 * @public
 */
export declare type FeedHint = {
    objectId: string;
    versionId: string;
};

/**
 * One durable feed page with an opaque continuation cursor.
 * @public
 */
export declare type FeedPage = {
    entries: FeedHint[];
    cursor: string;
    hasMore: boolean;
    [field: string]: unknown;
};

/**
 * Application identity, Local-first bucket and default Remote resources.
 * @public
 */
export declare type Instance = {
    readonly appId: string;
    readonly namespace: string;
    /** In-memory identity; null until supplied or restored/created by a Local auth operation. */
    readonly instanceKey: InstanceKey | null;
    /** Stable default Local-first handle; access performs no I/O. */
    readonly bucket: Bucket;
    /** Stable default protocol resources; direct use does not open storage. */
    readonly remote: Remote;
    /** Restores saved identity/access and handles startup callbacks without prompting. */
    resume(options?: {
        bucketId?: string;
    }): Promise<BucketState>;
    /** Stops sync and clears saved authorization; identity and local objects remain. */
    disconnect(options?: {
        bucketId?: string;
    }): Promise<void>;
    /** Subscribes to default connection status/details; returns an unsubscribe function. */
    on(event: "state", handler: (state: BucketState, detail?: string) => void): () => void;
    /** Releases owned runtime work and cancels remote requests without deleting data. */
    dispose(): void;
    createBucket(options?: {
        id?: string;
    }): Bucket;
    /** Reuses connected/saved access; opens authorization only when none is saved. */
    connect(options?: ConnectOptions & {
        bucketId?: string;
    }): Promise<Authorization>;
    /** Loads saved access and obtains a session without prompting or consuming callback URLs. */
    getSession(options?: {
        bucketId?: string;
        forceRefresh?: boolean;
    }): Promise<BearerCredential>;
};

/** Instance identity and non-extractable key handles. @public */
export declare type InstanceKey = {
    v: 1;
    instanceId: string;
    signingPublicJwk: JsonWebKey;
    signingPrivateKey: CryptoKey;
    wrappingPublicJwk: JsonWebKey;
    wrappingPrivateKey: CryptoKey;
    createdAt: string;
};

/**
 * Authorized resource capabilities and the bearer credential.
 * @public
 */
export declare type InstanceSession = {
    ok: true;
    mfid: string;
    instanceId: string;
    resourceId: string;
    capabilities: string[];
    credential: BearerCredential;
    [field: string]: unknown;
};

/** Authorized resource to exchange for a session. @public */
export declare type InstanceSessionInput = {
    mfid: string;
    resourceId: string;
};

/**
 * A local object listing entry.
 * @public
 */
export declare type ListEntry = {
    id: string;
    updatedAt: string;
    deleted?: true;
};

/**
 * A local data operation requires an authorized connection.
 * @public
 */
export declare class NotConnectedError extends Error {
    constructor();
}

/** A fixed remote version, with metadata separate from encrypted bytes. @public */
export declare type ObjectVersion<TPayload = Response> = {
    meta: VersionMeta;
    payload: TPayload;
};

/**
 * Synchronization requires an active cloud connection.
 * @public
 */
export declare class OfflineError extends Error {
    constructor();
}

/**
 * Explicit pagination; null or omitted cursor starts at the beginning.
 * @public
 */
export declare type PageOptions = RequestOptions & {
    cursor?: string | null;
    limit?: number;
};

/** Default remote resources; bindings are in memory and never persisted automatically. @public */
export declare interface Remote {
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

/** Authorization requests and session exchange using the owning Instance identity. @public */
export declare interface RemoteAuth extends SessionClient {
    /** Starts a popup authorization and returns verified access without saving or binding it. */
    authorize(options?: {
        mode?: "popup";
        bucketId?: string;
        signal?: AbortSignal;
    }): Promise<AuthorizationContext>;
    /** Saves pending state and the identity before navigating in this tab. */
    authorize(options: {
        mode: "redirect";
        bucketId?: string;
        signal?: AbortSignal;
    }): Promise<void>;
    authorize(options: {
        mode: "popup" | "redirect";
        bucketId?: string;
        signal?: AbortSignal;
    }): Promise<AuthorizationContext | void>;
    /** Restores a same-tab callback from the current URL; returns null when absent. */
    handleCallback(): Promise<AuthorizationContext | null>;
}

/**
 * Per-request cancellation.
 * @public
 */
export declare type RequestOptions = {
    signal?: AbortSignal;
};

/** Creates sessions using a bound identity; no storage, refresh or retry. @public */
export declare interface SessionClient {
    /** Requests a challenge, signs it and exchanges the proof for a bearer session. */
    createSession(input: InstanceSessionInput, options?: RequestOptions): Promise<InstanceSession>;
}

/** Connection and signing identity for session creation. @public */
export declare type SessionClientOptions = ApiOptions & {
    instanceKey: Pick<InstanceKey, "instanceId" | "signingPrivateKey">;
};

/**
 * One page of successful commits through a fixed version, newest first.
 * @public
 */
export declare type VersionHistory = VersionMeta & {
    history: string[];
    nextCursor: string | null;
};

/**
 * Protocol version metadata; unknown application fields are retained.
 * @public
 */
export declare type VersionMeta = {
    objectId: string;
    versionId: string;
    parentVersionIds: string[];
    payloadHash?: string;
    [field: string]: unknown;
};

export { }
