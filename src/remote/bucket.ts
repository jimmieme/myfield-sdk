import { ClientError } from "../errors.ts";
import { bytesToB64url, utf8Encode } from "../internal/encoding.ts";
import { createHttp, invalidResponse, networkError, readJson, record, requireString, string, throwIfAborted, type ApiOptions, type RequestOptions } from "./http.ts";

/**
 * Connection settings for one remote bucket.
 * @public
 */
export type BucketRemoteOptions = ApiOptions & {
  mfid: string;
  bucketId: string;
  getCredential(): { token: string } | Promise<{ token: string }>;
  /** Defaults to raw current-format upload. */
  schema?: CommitSchema;
};
/**
 * Protocol version metadata; unknown application fields are retained.
 * @public
 */
export type VersionMeta = {
  objectId: string;
  versionId: string;
  parentVersionIds: string[];
  payloadHash?: string;
  [field: string]: unknown;
};
/** A fixed remote version, with metadata separate from encrypted bytes. @public */
export type ObjectVersion<TPayload = Response> = { meta: VersionMeta; payload: TPayload };
/**
 * Current head with optional ancestry evidence requested by have.
 * @public
 */
export type CurrentVersion = {
  versionId: string;
  headVersionMeta: VersionMeta;
  /** Non-empty proves ancestry; [] is no stored proof; null is incomplete or bounded evidence. */
  history?: string[] | null;
  [field: string]: unknown;
};
/**
 * One page of successful commits through a fixed version, newest first.
 * @public
 */
export type VersionHistory = VersionMeta & { history: string[]; nextCursor: string | null };
/**
 * A prompt to check the durable feed, not the changed object contents.
 * @public
 */
export type FeedHint = { objectId: string; versionId: string };
/**
 * One durable feed page with an opaque continuation cursor.
 * @public
 */
export type FeedPage = { entries: FeedHint[]; cursor: string; hasMore: boolean; [field: string]: unknown };
/**
 * Current object heads and the cursor for subsequent feed catch-up.
 * @public
 */
export type BucketIndex = { bucketId: string; feedCursor: string | null; hasMoreFeed: boolean; objects: FeedHint[]; [field: string]: unknown };
/**
 * Readiness followed by change hints; ignore unrecognized future event types.
 * @public
 */
export type FeedEvent = { type: "ready" } | ({ type: "change" } & FeedHint);
/**
 * A write acknowledgement or normal CAS rejection; unknown results throw.
 * @public
 */
export type CommitResult = { ok: true } | { ok: false; reason: "version-mismatch" | "conflict" };
/**
 * A fixed version and ciphertext; explicit null CAS creates an object.
 * @public
 */
export type CommitInput = { meta: VersionMeta; payload: Blob | Uint8Array; expectedHeadVersionId: string | null;
  headState?: { headVersionId: string; historyMap: Record<string, string[]>; fieldSources: Record<string, string> };
};
/** Request encoding for the same commit endpoint; payload encryption stays with callers. @public */
export type CommitSchema = "current" | "legacy" | {
  encode(input: CommitInput): { body: Blob | Uint8Array | FormData; headers?: HeadersInit };
};
/**
 * Explicit pagination; null or omitted cursor starts at the beginning.
 * @public
 */
export type PageOptions = RequestOptions & { cursor?: string | null; limit?: number };

/**
 * A single-bucket protocol client without persistence, crypto or automatic retries.
 * @public
 */
export interface BucketRemote {
  /** Returns null for a missing object. Optional have requests ancestry evidence. */
  getCurrent(objectId: string, options?: RequestOptions & { have?: string | null }): Promise<CurrentVersion | null>;
  /** Reads fixed-version metadata and a streaming payload using two parallel requests. */
  getVersion(objectId: string, versionId: string, options?: RequestOptions): Promise<ObjectVersion>;
  /** Reads fixed-version metadata; a missing version throws. */
  getVersionMeta(objectId: string, versionId: string, options?: RequestOptions): Promise<VersionMeta>;
  /** Lists committed versions, not an ancestor graph; pagination is explicit. */
  listVersionHistory(objectId: string, versionId: string, options?: PageOptions): Promise<VersionHistory>;
  /** Returns a native Response; the caller consumes or cancels its body. */
  getPayload(objectId: string, versionId: string, options?: RequestOptions): Promise<Response>;
  /** Submits fixed bytes and a CAS condition; content semantics belong to its object encoding. */
  commit(input: CommitInput, options?: RequestOptions & { schema?: CommitSchema }): Promise<CommitResult>;
  /** Reads current heads and a nullable feed cursor; absence is not deletion. */
  getIndex(options?: RequestOptions): Promise<BucketIndex>;
  /** Reads one durable feed page; null cursor starts at the beginning. */
  listFeed(options?: PageOptions): Promise<FeedPage>;
  /** Opens one connection on iteration; yields ready before change hints, with no reconnect. */
  watchFeed(options?: RequestOptions): AsyncGenerator<FeedEvent>;
}

function isHint(value: unknown): value is FeedHint {
  return record(value) && string(value.objectId) && string(value.versionId);
}

function isMeta(value: unknown, objectId: string, versionId?: string): value is VersionMeta {
  return record(value) && value.objectId === objectId && string(value.versionId)
    && (versionId === undefined || value.versionId === versionId)
    && Array.isArray(value.parentVersionIds) && value.parentVersionIds.every(string);
}

function segment(id: string): string {
  requireString(id, "ID");
  if (id === "." || id === "..") throw new ClientError("INVALID_INPUT", "Dot segments cannot be requested");
  return encodeURIComponent(id);
}

function assertWritableId(id: string): void {
  requireString(id, "ID");
  if (id === "." || id.includes("..")) throw new ClientError("INVALID_INPUT", "Dot-segment IDs cannot be committed");
}

/**
 * Creates a protocol client scoped to one remote bucket ID.
 * @public
 */
export function createBucketRemote(options: BucketRemoteOptions): BucketRemote {
  const http = createHttp(options);
  const httpOptions = options;
  requireString(options.mfid, "mfid");
  const bucketId = options.bucketId;
  const root = `/v1/api/sync/buckets/${segment(options.bucketId)}`;
  const object = (id: string) => `${root}/objects/${segment(id)}`;
  const version = (id: string, versionId: string) => `${object(id)}/versions/${segment(versionId)}`;
  async function request(path: string, init: RequestInit = {}) {
    throwIfAborted(init.signal);
    const credential = await options.getCredential();
    requireString(credential?.token, "token");
    throwIfAborted(init.signal);
    const headers = new Headers(init.headers);
    headers.set("x-myfield-mfid", options.mfid);
    headers.set("authorization", `Bearer ${credential.token}`);
    return http(path, { ...init, headers });
  }
  async function json(path: string, options: RequestOptions) {
    const response = await request(path, { signal: options.signal });
    return { response, body: await readJson(response, options.signal) };
  }
  function pageQuery(options: PageOptions): URLSearchParams {
    const query = new URLSearchParams();
    if (options.cursor != null) {
      requireString(options.cursor, "cursor");
      query.set("cursor", options.cursor);
    }
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return query;
  }
  async function getVersionMeta(objectId: string, versionId: string, options: RequestOptions = {}): Promise<VersionMeta> {
    const { response, body } = await json(`${version(objectId, versionId)}/meta`, options);
    if (!isMeta(body, objectId, versionId)) throw invalidResponse(response);
    return body;
  }
  return {
    async getCurrent(objectId: string, options: RequestOptions & { have?: string | null } = {}): Promise<CurrentVersion | null> {
      const query = new URLSearchParams({ miss: "null" });
      if (options.have != null) {
        requireString(options.have, "have");
        query.set("have", options.have);
      }
      const { response, body } = await json(`${object(objectId)}/current?${query}`, options);
      if (body.versionId === null && body.headVersionMeta === null) return null;
      if (!string(body.versionId) || !isMeta(body.headVersionMeta, objectId, body.versionId)) throw invalidResponse(response);
      if (Object.hasOwn(body, "history") && body.history !== null && (!Array.isArray(body.history)
        || !body.history.every(string)
        || new Set(body.history).size !== body.history.length || (body.history.length > 0
          && (body.history[0] !== body.versionId || body.history.at(-1) !== options.have)))) throw invalidResponse(response);
      return body as CurrentVersion;
    },
    async getVersion(objectId: string, versionId: string, options: RequestOptions = {}): Promise<ObjectVersion> {
      const path = version(objectId, versionId);
      let payload: Response | undefined;
      let failed = false;
      const download = request(`${path}/payload`, { signal: options.signal }).then(response => {
        if (failed) void response.body?.cancel().catch(() => {});
        else payload = response;
        return response;
      });
      try {
        const [meta, response] = await Promise.all([getVersionMeta(objectId, versionId, options), download]);
        return { meta, payload: response };
      } catch (error) {
        failed = true;
        void payload?.body?.cancel().catch(() => {});
        throw error;
      }
    },
    getVersionMeta,
    async listVersionHistory(objectId: string, versionId: string, options: PageOptions = {}): Promise<VersionHistory> {
      const query = pageQuery(options);
      query.set("history", "full");
      const { response, body } = await json(`${version(objectId, versionId)}/meta?${query}`, options);
      if (!isMeta(body, objectId, versionId) || !Array.isArray(body.history) || !body.history.every(string)
        || !(body.nextCursor === null || string(body.nextCursor))) throw invalidResponse(response);
      return body as VersionHistory;
    },
    async getPayload(objectId: string, versionId: string, options: RequestOptions = {}): Promise<Response> {
      return request(`${version(objectId, versionId)}/payload`, { signal: options.signal });
    },
    async commit(input: CommitInput, options: RequestOptions & { schema?: CommitSchema } = {}): Promise<CommitResult> {
      if (!record(input) || !record(input.meta)) throw new ClientError("INVALID_INPUT", "Commit metadata is required");
      if (input.expectedHeadVersionId !== null) requireString(input.expectedHeadVersionId, "expectedHeadVersionId");
      assertWritableId(input.meta.objectId);
      assertWritableId(input.meta.versionId);
      if (!(input.payload instanceof Blob) && !(input.payload instanceof Uint8Array)) {
        throw new ClientError("INVALID_INPUT", "Payload must be a Blob or Uint8Array");
      }
      const schema = options.schema ?? httpOptions.schema ?? "current";
      let upload: Blob | Uint8Array | FormData = input.payload;
      let headers: Headers;
      if (schema === "legacy") {
        const form = new FormData();
        form.set("versionMeta", JSON.stringify(input.meta));
        if (input.headState) form.set("headState", JSON.stringify(input.headState));
        form.set("versionPayload", input.payload instanceof Blob ? input.payload : new Blob([input.payload as BlobPart]));
        if (input.expectedHeadVersionId !== null) form.set("expectedHeadVersionId", input.expectedHeadVersionId);
        upload = form; headers = new Headers();
      } else if (schema === "current") {
        if (input.headState) throw new ClientError("INVALID_INPUT", "headState requires a legacy or custom schema");
        headers = new Headers({ "content-type": "application/octet-stream",
          "x-myfield-version-meta": bytesToB64url(utf8Encode(JSON.stringify(input.meta))) });
        if (input.expectedHeadVersionId !== null) headers.set("x-myfield-expected-head-version-id", input.expectedHeadVersionId);
      } else if (record(schema) && typeof schema.encode === "function") {
        const encoded = schema.encode(input);
        if (!record(encoded)) throw new ClientError("INVALID_INPUT", "Invalid encoded commit request");
        upload = encoded.body; headers = new Headers(encoded.headers);
        if (!(upload instanceof Blob || upload instanceof Uint8Array || upload instanceof FormData)) throw new ClientError("INVALID_INPUT", "Invalid encoded commit body");
      } else throw new ClientError("INVALID_INPUT", "Invalid commit schema");
      const response = await request(object(input.meta.objectId), {
        method: "POST", headers, body: upload as BodyInit, signal: options.signal,
      });
      const body = await readJson(response, options.signal);
      if (body.ok === true) return body as CommitResult;
      if (body.ok === false && (body.reason === "version-mismatch" || body.reason === "conflict")) return body as CommitResult;
      if (schema !== "current" && body.ok === false && ["invalid-input", "unavailable", "unauthorized", "payload-too-large"].includes(String(body.reason))) {
        const status = body.reason === "unavailable" ? 503 : body.reason === "unauthorized" ? 401 : body.reason === "payload-too-large" ? 413 : 400;
        throw new ClientError(body.reason === "invalid-input" ? "INVALID_INPUT" : body.reason === "unavailable" ? "REMOTE_UNAVAILABLE" : body.reason === "unauthorized" ? "UNAUTHORIZED" : "OBJECT_TOO_LARGE",
          `Commit rejected: ${body.reason}`, { status, retryable: status === 503 });
      }
      throw invalidResponse(response, "Invalid commit result");
    },
    async getIndex(options: RequestOptions = {}): Promise<BucketIndex> {
      const { response, body } = await json(`${root}/objects:index`, options);
      if (body.bucketId !== bucketId || !Array.isArray(body.objects) || !body.objects.every(isHint)
        || !(body.feedCursor === null || typeof body.feedCursor === "string") || typeof body.hasMoreFeed !== "boolean") throw invalidResponse(response);
      return body as BucketIndex;
    },
    async listFeed(options: PageOptions = {}): Promise<FeedPage> {
      const { response, body } = await json(`${root}/feed?${pageQuery(options)}`, options);
      if (!Array.isArray(body.entries) || !body.entries.every(isHint) || typeof body.cursor !== "string"
        || typeof body.hasMore !== "boolean") throw invalidResponse(response);
      return body as FeedPage;
    },
    async *watchFeed(options: RequestOptions = {}): AsyncGenerator<FeedEvent> {
      const response = await request(`${root}/feed/stream`, { headers: { accept: "text/event-stream" }, signal: options.signal });
      if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream") {
        await response.body?.cancel().catch(() => {});
        throw invalidResponse(response, "Expected an event stream");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const cancel = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      let buffer = "", event = "", data: string[] = [], ready = false;
      try {
        throwIfAborted(options.signal);
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); }
          catch (cause) { networkError(cause, options.signal); }
          throwIfAborted(options.signal);
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          let match: RegExpExecArray | null;
          while ((match = /\r\n|\r|\n/.exec(buffer)) !== null) {
            if (!chunk.done && match.index === buffer.length - 1 && match[0] === "\r") break;
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (line === "") {
              if (event === "sync-ready" && data.length && !ready) {
                ready = true;
                yield { type: "ready" };
              }
              if (event === "sync-feed" && data.length) {
                if (!ready) throw invalidResponse(response, "Feed change received before readiness");
                let value: unknown;
                try { value = JSON.parse(data.join("\n")); }
                catch (cause) { throw invalidResponse(response, "Invalid feed event", cause); }
                const entries: unknown[] = record(value) && Array.isArray(value.entries) ? value.entries : [value];
                if (!entries.every(isHint)) throw invalidResponse(response, "Invalid feed hint");
                for (const entry of entries) {
                  throwIfAborted(options.signal);
                  const hint = entry as FeedHint;
                  yield { type: "change", objectId: hint.objectId, versionId: hint.versionId };
                }
              }
              event = ""; data = [];
            } else if (!line.startsWith(":")) {
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "event") event = value;
              if (field === "data") data.push(value);
            }
          }
          if (chunk.done) {
            if (!ready) throw invalidResponse(response, "Feed ended before readiness");
            break;
          }
        }
      } finally {
        options.signal?.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
