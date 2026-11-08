export {
  createInstance,
  type Bucket,
  type BinaryInput,
  type BinaryOptions,
  type BucketBinaryValue,
  type BucketState,
  type ConnectOptions,
  type CreateInstanceOptions,
  type Instance,
  type Authorization,
  type ListEntry,
} from "./facade.ts";
export { NotConnectedError } from "./errors.ts";
export { OfflineError } from "./bucket/transport.ts";

export { createSessionClient } from "./remote/session.ts";
export type { SessionClient, SessionClientOptions,
  InstanceSessionInput, InstanceSession, BearerCredential } from "./remote/session.ts";
export { createBucketRemote } from "./remote/bucket.ts";
export type { BucketRemote, BucketRemoteOptions, VersionMeta, ObjectVersion, CurrentVersion,
  VersionHistory, FeedHint, FeedEvent, FeedPage, BucketIndex, CommitInput, CommitResult, CommitSchema, PageOptions } from "./remote/bucket.ts";
export type { ApiOptions, RequestOptions } from "./remote/http.ts";
export { ClientError } from "./errors.ts";
export type { ClientErrorOptions } from "./errors.ts";
export { createInstanceKey } from "./crypto/instance.ts";
export type { InstanceKey } from "./crypto/instance.ts";
export type { AuthStorage } from "./auth/storage.ts";

export { createAuthorizationClient } from "./auth/client.ts";
export type { AuthorizationClient, AuthorizationClientOptions, AuthorizationContext, AuthorizationRequest } from "./auth/client.ts";
export { createAuthorizationStorage } from "./auth/storage.ts";
export type { AuthorizationStorage } from "./auth/storage.ts";

export type { Remote, RemoteAuth } from "./remote/client.ts";
