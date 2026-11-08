[@myfield/sdk](index.md) / CommitInput

# Type Alias: CommitInput

> **CommitInput** = `object`

A fixed version and ciphertext; explicit null CAS creates an object.

## Properties

| Property | Type |
| ------ | ------ |
| <a id="meta"></a> `meta` | [`VersionMeta`](VersionMeta.md) |
| <a id="payload"></a> `payload` | `Blob` \| `Uint8Array` |
| <a id="expectedheadversionid"></a> `expectedHeadVersionId` | `string` \| `null` |
| <a id="headstate"></a> `headState?` | `object` |
| `headState.headVersionId` | `string` |
| `headState.historyMap` | `Record`\<`string`, `string`[]\> |
| `headState.fieldSources` | `Record`\<`string`, `string`\> |
