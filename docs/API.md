# @myfield/sdk API Guide

Local manages storage, encryption, merge and sync; Remote exposes authorization and
HTTP operations. The excerpts below come from the runnable [Local](../examples/local-api.js)
and [Remote](../examples/remote-api.js) pages. See [README](../README.md#examples) to run
them, and [API Reference](api/index.md) for full signatures.

## Local API

### 1. Initialize

```js
// Omitted authBase uses https://myfield.one/auth/.
const instance = createInstance("local-api.example.com", { authBase });
const bucket = instance.bucket;
```

Handles are synchronous and perform no I/O. By default, appId is the namespace
and local bucket ID; reopening it reuses saved data and identity. Storage opens on first use.

### 2. Read and Save

Local reads and writes work without authorization or network access. Missing/deleted
objects return null. The example protects unsaved edits and writes only on Save:

```js
async function readNote() {
  const note = await bucket.get("note:1");
  if (!dirty) editor.value = note?.text ?? "";
}

save.onclick = () => action(async () => {
  await bucket.put("note:1", { text: editor.value });
  dirty = false;
  status.textContent = "Saved locally";
});
```

Save confirms local persistence, not upload. `bucket.on("change")` reports local
changes, including applied remote data, so the page can re-read the note.

### 3. Connect

After the first local read, start `instance.resume()` in the background to handle
callbacks and restore saved access without prompting. Connect is a user action:

```js
connect.onclick = () => action(() => instance.connect());
```

`connect()` reuses access or opens authorization when none is saved. Connection
failures retain authorization for `resume()` to retry; disconnect before authorizing again.

## Remote API

This example owns storage and a text codec, without merge, auto-sync or discovery.

### 1. Initialize

The page saves its key, object ID and grant using `createAuthorizationStorage` with
app-owned IndexedDB. It creates keys only when no record exists; concurrent loads
reuse the first inserted record. Invalid records stop without replacement.
Supply the saved key to `createInstance`; Remote shares that identity:

```js
instance = createInstance(appId, { instanceKey: record.instanceKey, authBase, authStorage: { database, store: "example" } });
```

### 2. Read and Save

After connecting (step 3), find the head, fetch its fixed version, then decode.
Remote uses wire IDs directly:

```js
async function readNote(client, grant) {
  const head = await client.getCurrent(record.objectId);
  let data = null;
  if (head) {
    const version = await client.getVersion(record.objectId, head.versionId);
    data = await decodeNoteVersion(version, grant);
  }
  if (!dirty) editor.value = data === null ? "" : new TextDecoder().decode(data);
  headVersionId = head?.versionId ?? null;
  status.textContent = "Loaded from remote";
}
```

Missing current returns null; missing fixed versions throw. `getVersion()` fetches
metadata and payload in parallel and returns `{ meta, payload: Response }`; consume
or cancel the body. Both can also be fetched separately.

For Save, construct encrypted bytes and metadata, then commit against the observed head:

```js
const version = await encodeNoteVersion({
  objectId: record.objectId, parentVersionIds: headVersionId ? [headVersionId] : [],
  data: encoder.encode(editor.value),
}, record.grant);
const result = await remote.commit({ ...version, expectedHeadVersionId: headVersionId });
if (!result.ok) throw new Error("Remote note changed. Reload before saving.");
```

Upload accepts `Blob` or `Uint8Array`. CAS rejection returns `{ ok: false, reason }`;
other failures throw [ClientError](api/ClientError.md). The page advances its head only
on success, and catches failures to pause writes and preserve edits. It has no durable
pending/confirmation: copy text before reload. Unknown/malformed ACKs and `retryable`
never prove the outcome; retain fixed bytes/meta/version ID after uncertain writes.

The [note codec](../examples/note-codec.js) encrypts UTF-8 text using the existing
JSON/AES-GCM envelope; Local encrypts LWW state. Encryption authenticates bucket/object,
not version/parents. Those checks only ensure consistency; unkeyed `payloadHash`
cannot prevent repackaging old ciphertext under new IDs. Apps own `{ meta, payload }`
codecs; SDK body codecs/new schemas are deferred.

### 3. Connect

The Connect handler reuses a saved grant or opens authorization, saves new access,
then calls `openRemote`:

```js
connect.onclick = () => action(async () => {
  if (remote) return;
  const grant = record.grant ?? await instance.remote.auth.authorize({ mode: "popup" });
  if (!record.grant) {
    const next = { ...record, grant };
    await storage.set("note", next);
    record = next;
  }
  await openRemote(grant);
});
```

`openRemote` binds access before reading:

```js
const server = instance.remote;
server.bind(grant);
const client = server.bucket;
```

Startup also calls `openRemote` when a grant is saved. For same-tab callbacks, it
first calls `instance.remote.auth.handleCallback()` and saves the returned grant;
without a callback, it returns null. Apps save grants; Remote binds them in memory.

## Connection and Lifecycle

| API | Behavior |
| --- | --- |
| `instance.on("state")` | Reports Local connection status and details. |
| `instance.getSession()` | Uses saved access without prompting or processing callbacks. |
| `instance.disconnect()` | Clears Local authorization and stops sync; retains identity and objects. |
| `instance.dispose()` | Stops owned runtime work without deleting saved data. |
| `remote.bind(grant)` / `unbind()` | Atomically sets or clears in-memory access; does not persist or revoke grants. |

Binding sets read-only `remote.authorization` and `remote.apiBase`; unbound
authorization is null. `instance.instanceKey` is null until supplied, restored or
created. Remote caches sessions in memory and coalesces refresh before expiry.
Rebinding/unbinding clears sessions and rejects late credentials from old bindings;
there is no public credential provider.

## Authorization Modes

| Operation | Behavior |
| --- | --- |
| `remote.auth.authorize({ mode: "popup" })` | Opens a popup and returns a grant. |
| `remote.auth.authorize({ mode: "redirect" })` | Saves identity/pending in IndexedDB, navigates, returns void. |
| `remote.auth.handleCallback()` | Restores/verifies URL/pending and cleans them on success. Returns a grant, or null without a callback. |

Remote returns grants without saving/binding them. Redirects use `authStorage` or the
default store; memory-only storage throws `AUTH_STORAGE_REQUIRED`. Invalid/expired/
unmatched callbacks fail without UI. New authorization cancels the same Instance's
old flow/popup (`AUTHORIZATION_CANCELLED`) and overwrites pending per resource/identity.
Repeated Local connect joins. Blocked popups report `AUTHORIZATION_BLOCKED`; Local
may fall back to redirect.

`authBase` defaults to `https://myfield.one/auth/`; `apiBase` comes from the grant,
without host inference. Standalone clients require an explicit HTTP(S) origin.
`createAuthorizationClient` provides pure request/callback operations;
`createSessionClient` handles challenge/sign/exchange without storage/cache/refresh.

## Compatibility and Ownership

- Local retains 0.9.1 IndexedDB records, JSON encryption, ID blinding, LWW merge
  and encrypted app-level deletion. Existing namespace-based calls remain supported.
  Keep namespace and bucket ID when adopting the appId constructor; defaults do not
  move existing data. `createBucket({ id })` retains isolated buckets.
- Instance owns lifecycle/state; Bucket owns data/change events. Legacy
  `bucket.resume/state/events` remain supported. `bucket.connect/disconnect` are
  deprecated; bucket connect returns state on auth failure where Instance throws.
  `bucket.ready()` is a deprecated no-op; storage errors surface on first use.
- Local operations/published access block `bind/unbind` (`REMOTE_MANAGED`);
  externally bound access requires unbind before Local takes over (`REMOTE_BOUND`).
  Failures preserve published access; disconnect invalidates pending operations.
  Resume without saved access/callbacks does not claim Remote.
- [CommitSchema](api/CommitSchema.md) selects HTTP encoding, not encryption.
  Remote forwards opaque bytes without deletion semantics. Current non-legacy
  Worker validation requires a parent and no `payloadHash` for empty content;
  other empty commits return 400. The example encrypts empty text; cloud records remain.

## History, Feed and Cancellation

- `getCurrent(objectId, { have })` evidence is newest-first through `have`: non-empty
  proves ancestry, `[]` provides no proof, and null means incomplete/bounded evidence.
  Omitting `have` skips history. `listVersionHistory()` lists commits, not an ancestor graph.
- Index/feed pagination uses explicit cursors; null starts at the beginning.
  `watchFeed()` opens one SSE connection on iteration and yields ready before hints.
  Catch up feed after ready and on hints; stream end does not prove catch-up.
- Requests accept `signal` and clients accept injected `fetch`. Remote has no automatic
  retry, pagination, reconnect or commit confirmation. See [BucketRemote](api/BucketRemote.md)
  and [CreateInstanceOptions](api/CreateInstanceOptions.md) for signatures.
