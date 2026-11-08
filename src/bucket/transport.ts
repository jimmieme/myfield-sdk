import { createBucketRemote, type BucketRemote } from "../remote/bucket.ts";
import { ClientError } from "../errors.ts";
// HTTP transport for the open bucket surface: GET current, GET version
// payload, object CAS write, and current-head listing. Session credentials
// come from the auth layer; a 401 triggers one forced session refresh and
// retry before the error escalates (the auth layer decides whether that
// means disconnected).

import { fnv1a32Bytes, utf8Encode } from "../internal/encoding.ts";
import { decryptEnvelope, encryptEnvelopeFields } from "./crypto.ts";
import type { BucketKeys } from "./keys.ts";

export type SessionCredential = { carrier: "bearer"; token: string } | { carrier: "cookie" };

export type SessionProvider = {
  getSession(options?: { forceRefresh?: boolean }): Promise<SessionCredential>;
  onUnauthorized?: () => void;
};

export type TransportHeadResult = { found: false } | { found: true; versionId: string };
export type TransportPayloadResult = { found: false } | { found: true; plaintext: Uint8Array };
export type TransportPullResult = { found: false } | { found: true; versionId: string; plaintext: Uint8Array };

export type TransportPushResult = { ok: true; versionId: string } | { ok: false; conflict: true; remoteVersionId: string | null };

// Thrown by sync attempts while the app is not connected. Local reads and
// writes never hit the transport, so local-first operation is unaffected;
// sync resumes once a connection is established.
/**
 * Synchronization requires an active cloud connection.
 * @public
 */
export class OfflineError extends Error {
  constructor() {
    super("not connected to cloud sync");
    this.name = "OfflineError";
  }
}

export class BucketTransportError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export type BucketTransportOptions = {
  remote?: BucketRemote;
  apiBase: string;
  mfid: string;
  keys: BucketKeys;
  sessionProvider: SessionProvider;
};

export class BucketTransport {
  private readonly remote: BucketRemote;
  private readonly keys: BucketKeys;
  private readonly sessionProvider: SessionProvider;

  constructor(options: BucketTransportOptions) {
    this.keys = options.keys;
    this.sessionProvider = options.sessionProvider;
    this.remote = options.remote ?? createBucketRemote({
      apiBase: options.apiBase.replace(/\/+$/, "").replace(/\/v1\/api\/sync$/, ""),
      mfid: options.mfid, bucketId: options.keys.bucketId, schema: "legacy",
      getCredential: async () => {
        const credential = await this.sessionProvider.getSession();
        if (credential.carrier !== "bearer") throw new ClientError("UNSUPPORTED_CREDENTIAL", "Bucket sessions must use bearer credentials");
        return credential;
      },
    });
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      try { return await run(); }
      catch (error) {
        if (!(error instanceof ClientError) || error.status !== 401) throw error;
        await this.sessionProvider.getSession({ forceRefresh: true });
        try { return await run(); }
        catch (retryError) {
          if (retryError instanceof ClientError && retryError.status === 401) this.sessionProvider.onUnauthorized?.();
          throw retryError;
        }
      }
    } catch (error) {
      if (error instanceof ClientError) throw new BucketTransportError(error.message, error.status ?? 503);
      throw error;
    }
  }

  async pullHead(wireObjectId: string): Promise<TransportHeadResult> {
    try {
      const current = await this.call(() => this.remote.getCurrent(wireObjectId));
      return current ? { found: true, versionId: current.versionId } : { found: false };
    } catch (error) {
      if (error instanceof BucketTransportError && error.status === 404) return { found: false };
      throw error;
    }
  }

  async pullPayload(wireObjectId: string, versionId: string): Promise<TransportPayloadResult> {
    try {
      const response = await this.call(() => this.remote.getPayload(wireObjectId, versionId));
      const plaintext = await decryptEnvelope(this.keys, wireObjectId, new Uint8Array(await response.arrayBuffer()));
      return { found: true, plaintext };
    } catch (error) {
      if (error instanceof BucketTransportError && error.status === 404) return { found: false };
      throw error;
    }
  }

  async pullCurrent(wireObjectId: string): Promise<TransportPullResult> {
    const head = await this.pullHead(wireObjectId);
    if (!head.found) return { found: false };
    const payload = await this.pullPayload(wireObjectId, head.versionId);
    return payload.found ? { found: true, versionId: head.versionId, plaintext: payload.plaintext } : { found: false };
  }

  async push(wireObjectId: string, plaintext: Uint8Array, expectedHeadVersionId: string | null): Promise<TransportPushResult> {
    const versionId = crypto.randomUUID();
    const kind = expectedHeadVersionId === null ? "create" : "update";
    const parentVersionIds = expectedHeadVersionId === null ? [] : [expectedHeadVersionId];
    const cipherFields = await encryptEnvelopeFields(this.keys, wireObjectId, plaintext);
    const payload = utf8Encode(JSON.stringify({ objectId: wireObjectId, versionId, kind, parentVersionIds, ...cipherFields }));
    const meta = { objectId: wireObjectId, versionId, parentVersionIds,
      contentHash: fnv1a32Bytes(plaintext), kind, timestamp: Date.now() };
    const result = await this.call(() => this.remote.commit({ meta, payload, expectedHeadVersionId,
      headState: { headVersionId: versionId, historyMap: { [versionId]: parentVersionIds }, fieldSources: {} } }, { schema: "legacy" }));
    return result.ok ? { ok: true, versionId } : { ok: false, conflict: true, remoteVersionId: null };
  }

  async listHeads(): Promise<Map<string, string>> {
    const index = await this.call(() => this.remote.getIndex());
    const heads = new Map(index.objects.map(entry => [entry.objectId, entry.versionId]));
    let cursor = index.feedCursor;
    for (let page = 0, hasMore = index.hasMoreFeed; hasMore; page++) {
      if (page >= 10_000) throw new BucketTransportError("feed did not end within page limit", 500);
      const result = await this.call(() => this.remote.listFeed({ cursor, limit: 100 }));
      for (const entry of result.entries) heads.set(entry.objectId, entry.versionId);
      if (result.cursor === cursor) break;
      cursor = result.cursor; hasMore = result.hasMore;
    }
    return heads;
  }
}
