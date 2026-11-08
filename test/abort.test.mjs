import assert from "node:assert/strict";
import test from "node:test";
import { combineSignals, releaseResponse } from "../src/internal/abort.ts";

function fallback(t) {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "any", descriptor));
}
function source(t) {
  const controller = new AbortController();
  const add = t.mock.method(controller.signal, "addEventListener");
  const remove = t.mock.method(controller.signal, "removeEventListener");
  return { controller, signal: controller.signal, add, remove };
}

test("fallback signal composition forwards either cancellation and removes listeners", t => {
  fallback(t);
  for (const abortFirst of [true, false]) {
    const first = source(t), second = source(t);
    const scope = combineSignals([first.signal, second.signal]);
    const reason = new Error("cancelled");
    (abortFirst ? first : second).controller.abort(reason);
    assert.equal(scope.signal.reason, reason);
    assert.equal(first.remove.mock.calls.length, 1);
    assert.equal(second.remove.mock.calls.length, 1);
  }
  const already = new AbortController(); already.abort("earlier");
  assert.equal(combineSignals([new AbortController().signal, already.signal]).signal.reason, "earlier");
});

test("fallback response keeps cancellation active after headers until body completion", async t => {
  fallback(t);
  const first = source(t), second = source(t), scope = combineSignals([first.signal, second.signal]);
  const original = new Response(new ReadableStream({ start(controller) {
    scope.signal.addEventListener("abort", () => controller.error(scope.signal.reason), { once: true });
  } }));
  const response = releaseResponse(original, scope.dispose);
  const reading = response.text();
  assert.equal(first.remove.mock.calls.length, 0);
  const reason = new Error("disposed after headers");
  second.controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
  assert.ok(first.remove.mock.calls.length > 0);
  assert.ok(second.remove.mock.calls.length > 0);
});

test("fallback responses release signal listeners on completion and cancellation", async t => {
  fallback(t);
  for (const cancel of [false, true]) {
    const first = source(t), second = source(t), scope = combineSignals([first.signal, second.signal]);
    const original = new Response("payload", { status: 201, headers: { "x-request-id": "request" } });
    Object.defineProperty(original, "url", { value: "https://api.example.test/payload" });
    const response = releaseResponse(original, scope.dispose);
    assert.equal(response.status, 201); assert.equal(response.url, original.url);
    assert.equal(response.headers.get("x-request-id"), "request");
    if (cancel) await response.body.cancel();
    else assert.equal(await response.text(), "payload");
    assert.ok(first.remove.mock.calls.length > 0);
    assert.ok(second.remove.mock.calls.length > 0);
  }
});
