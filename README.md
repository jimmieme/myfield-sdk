# @myfield/sdk

Myfield SDK for third-party web apps: local-first object storage,
end-to-end-encrypted sync, internal Myfield authorization, and remote protocol clients.

The Local API mental model: a bucket is a local-first **end-to-end-encrypted object KV
with CAS-backed sync**. Local CRUD works with no account and no network;
`connect()` controls interactive authorization. Local operations remain available
when cloud requests fail; synchronization resumes when connectivity returns.

Status: 1.0 preview. `0.9.0` reflects our assessment that the SDK design has
reached its baseline shape; minor adjustments — including to the public API
— are still possible before 1.0 based on community feedback and real-world
use, and 1.0 will freeze the API/protocol, with later versions extending it
while keeping compatibility. License: Apache-2.0.

## Quickstart

```ts
import { createInstance } from "@myfield/sdk";

const instance = createInstance("app.example.com");
const bucket = instance.bucket;

// Read local data before restoring saved access / handling an auth callback.
const note = await bucket.get("note:1");
void instance.resume().catch(console.error);

// Local-first object CRUD works before authorization.
await bucket.put("note:1", { title: "hello", body: "world" });
await bucket.update("note:1", { body: undefined }); // deletes the field
const entries = await bucket.list({ prefix: "note:" });

// On the user's "Connect" click: reuse access or open authorization
// (popup, or same-tab on iOS).
await instance.connect(); // defaults to https://myfield.one/auth/
```

Existing apps should retain their namespace and bucket id when adopting the new
constructor; its defaults do not move existing data. Local keeps the 0.9.1 format.

## Remote API

`instance.remote.auth` provides authorization and sessions; `instance.remote.bucket`
provides HTTP operations, including feed and SSE. Apps bind a verified grant and
own payload encoding, saved grants and synchronization. Remote manages sessions
in memory; same-tab authorization persists pending state and identity.

See the [API guide](docs/API.md) for Local/Remote examples and
[documentation index](docs/README.md) for the full reference.

## What the SDK handles

The following applies to the Local API.

- **Auth**: instance keygen, the `https://myfield.one/auth/` authorization
  flow (popup / same-tab), callback decryption, bearer session refresh, and
  the unauthorized → disconnected transition. Instance owns connection/state;
  Bucket owns local data and sync.
- **Pairwise identity**: authorization is alias-only. Your app sees an alias
  id for the user, never their global Myfield identity; different apps see
  different aliases and cannot correlate users across apps.
- **Encryption**: sync payload content is encrypted client-side; Local IndexedDB
  stores decoded records. Object ids are blinded — your semantic ids
  (`note:1`, `note:list`) never reach the wire.
- **Merge**: objects are field maps with last-write-wins per field
  (a state-based CRDT), so multi-device edits converge without conflicts
  surfacing to the app. Custom merge hooks are not exposed by the Local API.
- **Sync triggers**: launch/resume, post-write debounce, and a timer
  fallback. Browser lifecycle triggers such as focus/visibility are app
  choices: call `bucket.sync()` from those handlers when that fits your UI.
  The Local API does not use server push.

## Design boundaries

- **Local-first**: reads and writes use local storage, independently of network
  availability. The SDK synchronizes changes in the background when connected.
- **Private content**: clients encrypt content and blind object IDs before upload.
  The cloud stores encrypted versions but still sees sizes, timing and content hashes.
- **Authorization**: grants control cloud access. Revocation stops future access;
  it cannot withdraw data or keys a device already holds.
- **Storage and sync**: MyField supports versioned storage and multi-device sync.
  Durability and backup guarantees depend on the cloud service; realtime
  collaboration and presence require additional application logic.

## Current service status

The auth service returns `resourceApiUrl` in the encrypted callback; Local binds
it to `instance.remote.apiBase` without deployment-host inference. Remote uses the
bound grant's API address; standalone protocol clients require an explicit origin.
Local continues timer-based synchronization over the object index and feed.

## Public entry

| Entry | Contents |
| --- | --- |
| `@myfield/sdk` | Instance, Local/Remote resources, identity/storage helpers, types and errors |

Instance/Bucket/Remote handles perform no I/O; Local storage opens on first use.
Local persistence defaults to IndexedDB. A memory backend is available for
tests and ephemeral clients; custom storage factories are lower-level
building blocks, not the v1 quickstart API.

Internal source modules under `src/auth` and `src/bucket` exist for
implementation and tests, but are not exported package subpaths in v1.

Compatible implementation details for SDK maintainers and future language
ports (payload layout, merge rules, id derivation): see
[`docs/BUCKET-SPEC.md`](./docs/BUCKET-SPEC.md).

## Development

This package is dependency-free at runtime and managed independently of the
monorepo workspace (standalone lockfile) so it can be extracted cleanly.

```sh
pnpm install --ignore-workspace
npm run build
npm test          # node --test (contract layer, mocked relay/auth)
npm run typecheck # tsc --noEmit
npm run typecheck:api
npm run test:compat # requires the local v0.9.1 tag
npm run api:check
```

Repository-level maintainer browser E2E lives under `tests/sdk-e2e/` and is
run from the workspace root with `pnpm run test:sdk:e2e`.

Edit API descriptions in source TSDoc and run `npm run api:update` to regenerate
public declarations, `docs/api/` and the API report. Usage lives in `docs/API.md`.

### Examples

After building, run `python3 -m http.server 8000` from this SDK repository and open
[Local API example](http://localhost:8000/examples/local-api.html) or
[Remote API example](http://localhost:8000/examples/remote-api.html).
Use `?authBase=<authorization-page-url>` to select a custom authorization page.
Source: [Local example source](examples/local-api.js), [Remote example source](examples/remote-api.js).

The Remote example saves identity, grant and object ID in this browser; it has no
object discovery or multi-device sync. Clearing storage loses saved access;
incompatible prerelease records stop without replacement.

After building, `npm run test:browser -- /path/to/myfield` verifies Chrome persistence,
callbacks and examples with mock services. `npm run test:live -- /path/to/myfield`
creates a dev test identity and checks Auth/Worker/R2 using synthetic ciphertext.
Test objects are cleared; cloud records remain. `API_BASE` and `AUTH_BASE` override
the test environment.
