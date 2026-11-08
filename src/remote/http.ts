import { ClientError } from "../errors.ts";

/**
 * Per-request cancellation.
 * @public
 */
export type RequestOptions = { signal?: AbortSignal };
/**
 * An HTTP(S) service origin and optional fetch implementation.
 * @public
 */
export type ApiOptions = { apiBase: string; fetch?: typeof globalThis.fetch };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
}

export function invalidResponse(response: Response, message = "Invalid protocol response", cause?: unknown): ClientError {
  return new ClientError("INVALID_RESPONSE", message, {
    status: response.status, requestId: response.headers.get("x-request-id") ?? undefined, cause,
  });
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  signal?.throwIfAborted();
}

export function networkError(cause: unknown, signal?: AbortSignal | null): never {
  throwIfAborted(signal);
  if (cause instanceof Error && cause.name === "AbortError") throw cause;
  throw new ClientError("NETWORK_ERROR", "Network request failed", { retryable: true, cause });
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); }
  catch (cause) {
    throwIfAborted(signal);
    if (!(cause instanceof SyntaxError)) return networkError(cause, signal);
    throw invalidResponse(response, "Invalid JSON response", cause);
  }
  if (!record(value)) throw invalidResponse(response);
  return value;
}

export function createHttp(options: ApiOptions) {
  requireString(options.apiBase, "apiBase");
  let base: URL;
  try { base = new URL(options.apiBase); }
  catch (cause) { throw new ClientError("INVALID_INPUT", "apiBase must be an HTTP(S) origin", { cause }); }
  if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new ClientError("INVALID_INPUT", "apiBase must be an HTTP(S) origin without a path, query, fragment or credentials");
  }
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    throwIfAborted(init.signal);
    let response: Response;
    try { response = await fetch(new URL(path, base).href, { ...init, credentials: "omit" }); }
    catch (cause) { return networkError(cause, init.signal); }
    if (response.ok) return response;
    let body: Record<string, unknown> = {};
    try {
      const value: unknown = await response.json();
      if (record(value)) body = value;
    } catch { throwIfAborted(init.signal); }
    finally { await response.body?.cancel().catch(() => {}); }
    const details = record(body.details) ? body.details : {};
    const retry = response.headers.get("retry-after");
    const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
    const date = retry === null ? NaN : Date.parse(retry);
    const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
    throw new ClientError(string(body.code) ? body.code : "HTTP_ERROR",
      string(body.message) ? body.message : string(body.error) ? body.error : `HTTP ${response.status}`, {
        status: response.status,
        requestId: string(body.requestId) ? body.requestId : response.headers.get("x-request-id") ?? undefined,
        retryable: typeof details.retryable === "boolean" ? details.retryable
          : response.status === 408 || response.status === 429 || response.status >= 500,
        retryAfterMs,
        maxBytes: typeof details.maxBytes === "number" ? details.maxBytes : undefined,
      });
  };
}
