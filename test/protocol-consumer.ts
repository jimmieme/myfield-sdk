import { createBucketRemote, createSessionClient, createInstanceKey, ClientError, type CommitResult, type VersionMeta } from "@myfield/sdk";

const instanceKey = await createInstanceKey();
const sessions = createSessionClient({ apiBase: "https://api.example", instanceKey });
const session = await sessions.createSession({ mfid: "owner", resourceId: "resource" });
const remote = createBucketRemote({ apiBase: "https://api.example", mfid: "owner", bucketId: "bucket",
  getCredential: () => ({ token: "token" }) });
const meta: VersionMeta = { objectId: "a", versionId: "v1", parentVersionIds: [], payloadHash: "hash", extension: true };
const result: CommitResult = await remote.commit({ meta, payload: new Blob(), expectedHeadVersionId: null });
if (!result.ok) console.log(result.reason);
const response: Response = await remote.getPayload("a", "v1");
for await (const hint of remote.watchFeed({ signal: AbortSignal.abort() })) if (hint.type === "change") console.log(hint.objectId);
console.log(session.instanceId, response, new ClientError("FAILED", "Failed").retryAfterMs);

const index = await remote.getIndex();
await remote.listFeed({ cursor: index.feedCursor });
const history = await remote.listVersionHistory("a", "v1");
await remote.listVersionHistory("a", "v1", { cursor: history.nextCursor });

await remote.getCurrent("a", { have: null });

import { createInstance, type Bucket } from "@myfield/sdk";
const legacyBucket: Bucket = createInstance({ storage: "memory" }).createBucket({ id: "legacy.example" });
await legacyBucket.ready();
// @ts-expect-error Internal testing hooks must not leak into the public declarations.
legacyBucket.__bindTestTransport({});

import { type Authorization, type CommitSchema } from "@myfield/sdk";
const instance = createInstance("notes.example", { instanceKey, storage: "memory" });
const defaultBucket = instance.createBucket();
const authorization: Authorization = await instance.connect({ autoSync: false });
await instance.getSession();
await authorization.getSession();
const schema: CommitSchema = { encode: input => ({ body: input.payload }) };
await remote.commit({ meta, payload: new Blob(), expectedHeadVersionId: null }, { schema });
console.log(defaultBucket.id, instance.appId);

import { type ObjectVersion } from "@myfield/sdk";
const downloaded: ObjectVersion = await remote.getVersion("opaque", "version");
const downloadedBytes: ArrayBuffer = await downloaded.payload.arrayBuffer();
console.log(downloadedBytes);

import { createAuthorizationClient, createAuthorizationStorage, type AuthorizationContext, type AuthorizationRequest } from "@myfield/sdk";
declare const database: IDBDatabase;
const authStorage = createAuthorizationStorage({ database, store: "authorization" });
const authorizations = createAuthorizationClient({ appId: "notes.example.com", instanceKey, redirectUri: "https://notes.example.com/" });
const pending: AuthorizationRequest = authorizations.createRequest();
await authStorage.set("pending", pending);
const granted: AuthorizationContext = await authorizations.handleCallback("https://notes.example.com/?callback", pending);
await authStorage.set("grant", granted);
const restored = await authStorage.get<AuthorizationContext>("grant");
if (restored) console.log(restored.bucketId, restored.payloadKey);


import { type Remote, type RemoteAuth } from "@myfield/sdk";
const defaultRemote: Remote = instance.remote;
const remoteAuth: RemoteAuth = defaultRemote.auth;
const identityOrNull = instance.instanceKey;
const defaultLocal = instance.bucket;
const stopState = instance.on("state", (state, detail) => console.log(state, detail));
await instance.resume();
defaultRemote.bind(granted);
const boundGrant: AuthorizationContext | null = defaultRemote.authorization;
// @ts-expect-error Authorization is read-only.
defaultRemote.authorization = granted;
// @ts-expect-error Service origin comes from the grant.
defaultRemote.apiBase = granted.apiBase;
const callbackGrant: AuthorizationContext | null = await remoteAuth.handleCallback();
const popupGrant: AuthorizationContext = await remoteAuth.authorize({ mode: "popup" });
const redirectResult: void = await remoteAuth.authorize({ mode: "redirect" });
await remoteAuth.createSession({ mfid: granted.mfid, resourceId: granted.resourceId });
await defaultRemote.bucket.getCurrent("opaque");
defaultRemote.unbind();
await instance.disconnect();
stopState(); instance.dispose();
console.log(identityOrNull, defaultLocal);
