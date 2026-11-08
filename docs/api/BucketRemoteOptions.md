[@myfield/sdk](index.md) / BucketRemoteOptions

# Type Alias: BucketRemoteOptions

> **BucketRemoteOptions** = [`ApiOptions`](ApiOptions.md) & `object`

Connection settings for one remote bucket.

## Type Declaration

### mfid

> **mfid**: `string`

### bucketId

> **bucketId**: `string`

### getCredential()

> **getCredential**(): \{ `token`: `string`; \} \| `Promise`\<\{ `token`: `string`; \}\>

#### Returns

\{ `token`: `string`; \} \| `Promise`\<\{ `token`: `string`; \}\>

### schema?

> `optional` **schema?**: [`CommitSchema`](CommitSchema.md)

Defaults to raw current-format upload.
