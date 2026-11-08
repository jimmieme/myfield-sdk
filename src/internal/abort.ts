export function combineSignals(signals: [AbortSignal, ...AbortSignal[]]): { signal: AbortSignal; dispose?: () => void } {
  if (signals.length === 1) return { signal: signals[0] };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(signals) };
  const controller = new AbortController();
  const dispose = () => { for (const signal of signals) signal.removeEventListener("abort", abort); };
  function abort(event: Event): void { controller.abort((event.target as AbortSignal).reason); dispose(); }
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); dispose(); break; }
    signal.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}

export function releaseResponse(response: Response, dispose?: () => void): Response {
  if (!dispose) return response;
  if (!response.body) { dispose(); return response; }
  // Keep cancellation linked until the response body finishes or is cancelled.
  const reader = response.body.getReader();
  const finish = () => { dispose(); reader.releaseLock(); };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { finish(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  });
  const result = new Response(body, response);
  for (const field of ["url", "type", "redirected"] as const) Object.defineProperty(result, field, { value: response[field] });
  return result;
}
