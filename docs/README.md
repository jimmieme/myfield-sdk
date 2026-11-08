# SDK Documentation

Both Local and Remote APIs are supported. Local authorization and sync compose
Remote clients while preserving existing records and ciphertext.

| Document | Purpose |
| --- | --- |
| [API Guide](API.md) | Local data and remote usage, behavior, errors and boundaries |
| [API Reference](api/index.md) | Generated signatures, types and method descriptions |
| [Bucket Spec](BUCKET-SPEC.md) | SDK 0.9.1 Local encoding, encryption and merge rules |
| [Protocol Schemas](schemas/bucket-protocol.schema.json) | Metadata and legacy headState structures |

The API guide shows Local and Remote usage. Local retains the published 0.9.1
format; Remote treats payload as opaque bytes. Protocol schemas cover HTTP metadata/
headState, not encryption or decrypted Local fields such as tombstones or ~deleted.

Edit API signatures/descriptions in source TSDoc, then run `npm run api:update`.
Keep usage and format explanations in API.md and BUCKET-SPEC.md; do not duplicate
signatures there. `npm run api:check` checks generated documentation/declarations
and the public API report in `etc/sdk.api.md`. See the [package README](../README.md)
for build and verification commands.
