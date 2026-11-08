import { ClientError } from "../errors.ts";
import type { AuthorizationRequest } from "./client.ts";

export function createAuthorizationFlow() {
  type Pending = { controller: AbortController; requestId?: string; retained: boolean };
  let current: Pending | undefined;
  async function execute<T>(pending: Pending, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, retain = false): Promise<T> {
    const controller = pending.controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([action(controller.signal), aborted]); }
    catch (error) { controller.abort(error); throw error; }
    finally {
      controller.signal.removeEventListener("abort", onAbort);
      if (!retain || controller.signal.aborted) {
        signal?.removeEventListener("abort", abort);
        if (current === pending) current = undefined;
        controller.abort();
      } else {
        pending.retained = true;
        controller.signal.addEventListener("abort", () => signal?.removeEventListener("abort", abort), { once: true });
      }
    }
  }
  return {
    run<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, retain = false): Promise<T> {
      signal?.throwIfAborted();
      current?.controller.abort(new ClientError("AUTHORIZATION_CANCELLED", "Authorization replaced by a new request"));
      current = { controller: new AbortController(), retained: false };
      return execute(current, action, signal, retain);
    },
    identify(signal: AbortSignal, requestId: string): void {
      signal.throwIfAborted();
      if (current?.controller.signal !== signal) throw new ClientError("AUTHORIZATION_CANCELLED", "Authorization was replaced");
      current.requestId = requestId;
    },
    restore<T>(requestId: string, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (current && (!current.retained || current.requestId !== requestId)) return Promise.reject(new ClientError("INVALID_AUTHORIZATION", "Callback does not match the active authorization"));
      current ??= { controller: new AbortController(), requestId, retained: false };
      return execute(current, action, signal);
    },
    cancel(reason: unknown) { current?.controller.abort(reason); },
  };
}
export type AuthorizationFlow = ReturnType<typeof createAuthorizationFlow>;

export function openAuthorizationPopup<T>(options: {
  request: AuthorizationRequest | (() => Promise<AuthorizationRequest>);
  signal: AbortSignal;
  callback(url: string, request: AuthorizationRequest, signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const { signal } = options;
  signal.throwIfAborted();
  if (typeof window === "undefined") return Promise.reject(new ClientError("BROWSER_REQUIRED", "Authorization requires a browser"));
  const browser = window;
  let request = typeof options.request === "function" ? undefined : options.request;
  const popupUrl = (value: AuthorizationRequest) => {
    const url = new URL(value.url); url.searchParams.set("callbackTransport", "popup"); return url.href;
  };
  let popup: Window | null;
  try { popup = browser.open(request ? popupUrl(request) : "about:blank", "_blank", "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes"); }
  catch (cause) { return Promise.reject(new ClientError("AUTHORIZATION_BLOCKED", "Could not open authorization popup", { cause })); }
  if (!popup) return Promise.reject(new ClientError("AUTHORIZATION_BLOCKED", "Authorization popup was blocked"));
  const authWindow = popup;
  return new Promise((resolve, reject) => {
    let processing = false, settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(timeout);
      browser.removeEventListener("message", onMessage); signal.removeEventListener("abort", onAbort);
      authWindow.close();
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const onAbort = () => finish(signal.reason);
    const onMessage = (event: MessageEvent) => {
      if (settled || processing || !request || event.source !== authWindow || event.origin !== new URL(request.url).origin
        || event.data?.type !== "myfield.auth.callback" || typeof event.data.callbackUrl !== "string") return;
      processing = true;
      void options.callback(event.data.callbackUrl, request, signal).then(value => {
        signal.throwIfAborted(); finish(undefined, value);
      }).catch(error => finish(error));
    };
    const poll = setInterval(() => { if (!processing && authWindow.closed) finish(new ClientError("AUTHORIZATION_CANCELLED", "Authorization window closed")); }, 500);
    const timeout = setTimeout(() => finish(new ClientError("AUTHORIZATION_EXPIRED", "Authorization request expired")), 600_000);
    browser.addEventListener("message", onMessage); signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (typeof options.request === "function") void options.request().then(value => {
      signal.throwIfAborted(); request = value; authWindow.location.href = popupUrl(value); authWindow.focus();
    }).catch(error => finish(error));
  });
}

export function hasAuthorizationCallback(url: string): boolean {
  const parsed = new URL(url);
  return parsed.searchParams.has("mf_request_id") || parsed.searchParams.has("mf_result")
    || new URLSearchParams(parsed.hash.slice(1)).has("mf_auth_result");
}
export function clearCallbackUrl(): void {
  const url = new URL(window.location.href);
  for (const key of ["state", "error", "error_description", "error_uri", "mf_request_id", "mf_result"]) url.searchParams.delete(key);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (hash.has("mf_auth_result")) { hash.delete("mf_auth_result"); url.hash = hash.toString(); }
  try { window.history.replaceState(null, "", url.href); } catch {}
}
