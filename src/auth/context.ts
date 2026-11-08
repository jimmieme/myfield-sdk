import type { AuthorizationContext } from "./client.ts";
import type { BucketAccessGrant } from "./instance.ts";
import type { InstanceKey } from "../crypto/instance.ts";
import { unwrapBucketKeys } from "../bucket/keys.ts";
import { ClientError } from "../errors.ts";

export async function authorizationContext(result: {
  mfid: string; instanceId: string; resourceApiUrl?: string; bucketAccessGrant?: BucketAccessGrant;
}, instance: InstanceKey): Promise<AuthorizationContext> {
  try {
    const grant = result.bucketAccessGrant!;
    if (grant.resourceId !== `urn:myfield:bucket:${grant.envelope.bucketId}`) throw new Error("Grant bucket mismatch");
    const endpoint = new URL(result.resourceApiUrl ?? "");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !["/", "/v1/api/sync", "/v1/api/sync/"].includes(endpoint.pathname)) throw new Error("Invalid resource URL");
    const keys = await unwrapBucketKeys(grant.envelope, instance.wrappingPrivateKey);
    return { mfid: result.mfid, instanceId: result.instanceId, bucketId: keys.bucketId,
      resourceId: grant.resourceId, apiBase: endpoint.origin, keyId: keys.keyId,
      payloadKey: keys.payloadKey, capabilities: [...grant.capabilities] };
  } catch (cause) { throw new ClientError("INVALID_AUTHORIZATION", "Could not validate or decrypt authorization", { cause }); }
}
