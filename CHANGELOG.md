# Changelog

## 0.9.2-alpha.0 (unreleased)

- Add unified Instance resources: default bucket/remote, combined remote.auth,
  atomic grant binding, read-only authorization/address and top-level lifecycle/events.
  Remote manages in-memory sessions; Local retains private transports. Popup/HTTP
  calls do not open storage; redirect authorization persists identity/pending.
  Failed Local operations preserve published access; disconnect invalidates pending
  publication. Disposal cancels owned requests,
  including on browsers without AbortSignal.any.
- Share popup/callback handling across Local and Remote. Remote authorize selects
  popup/redirect; handleCallback restores IndexedDB pending state without saving
  grants. New authorization replaces the prior flow; old pending records remain readable.
- Deprecate bucket.connect/disconnect in favor of Instance lifecycle methods.
  bucket.ready is now a deprecated no-op: initialization and storage errors move
  to the first data operation, rather than the legacy preflight call.

- Reuse active/saved access in both connect APIs; restore failures never open auth.
  Reauthorization requires disconnect/connect. Keep legacy state results and new
  instance errors distinct; getSession never consumes callback URLs.
- Reject identity-mismatched callbacks before saving and clean only their pending
  state. Restore bucket ID trimming/coercion.

- Add thin session and bucket protocol clients with injected fetch, cancellation,
  explicit pagination, CAS results and a single-connection SSE iterator.
- Add ClientError for HTTP/network/protocol failures; no automatic retries or
  commit confirmation. Keep local-first APIs supported and documented, without a
  removal deadline. Preserve existing records and ciphertext.
- Compose legacy Local sync/auth through Remote, with legacy/custom commit encoding
  and fail-closed upload acknowledgement.
- Add pure instance keys/signing, optional application-owned auth storage, appId
  defaults, explicit instance authorization and silent session retrieval.
- Reuse persisted identity under concurrent initialization; coalesce session refresh,
  preserve authorization on network failure and isolate failing listeners.
- Bind keys to session clients and keep the fixed challenge/sign/session handshake internal.
- Add getVersion over the existing metadata/payload endpoints without changing
  Local encryption, LWW state, deletion or storage formats.
- Separate authorization request/callback processing from explicit IndexedDB persistence;
  return the granted non-extractable data key/context and preserve Local auto-save.
- Keep JSON envelope encoding in an example-owned module; no new payload format
  or public object-body crypto helpers.
- Use the granted key in the Remote example, refresh expired sessions and pause
  saves after uncertain commits.
- Add runnable Local/Remote HTML examples and source excerpts in the API guide.
- Generate declarations, API reports and reference documentation from source TSDoc.

## 0.9.1

- Sync uses the relay's object index; `~index` is no longer pushed.
- Fixed a second write in the same millisecond not reaching other devices.

## 0.9.0

First public release.

- `createInstance()` / `instance.createBucket({ id })` public facade with
  local-first `put`/`get`/`update`/`delete`/`list` object CRUD.
- Instance auth: `connect()` / `disconnect()`, popup and same-tab (iOS)
  authorization flows against `https://myfield.one/auth/`, alias-only
  pairwise identity, callback envelope decryption, bearer session refresh,
  and the unauthorized-to-disconnected transition.
- Bucket sync: three-route CAS transport, deterministic object-id blinding,
  encrypted field-map (LWW) payload format with tombstones and a hybrid
  clock, pluggable merge strategies, IndexedDB and memory storage adapters.
- Sync triggers: launch/resume, post-write debounce, and a timer fallback;
  browser lifecycle sync (focus/visibility) is left to the app.
- `docs/BUCKET-SPEC.md` format reference (payload layout, merge rules, id
  derivation).
