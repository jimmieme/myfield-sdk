[@myfield/sdk](index.md) / BucketRemote

# Interface: BucketRemote

A single-bucket protocol client without persistence, crypto or automatic retries.

## Methods

### getCurrent()

> **getCurrent**(`objectId`, `options?`): `Promise`\<[`CurrentVersion`](CurrentVersion.md) \| `null`\>

Returns null for a missing object. Optional have requests ancestry evidence.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) & `object` |

#### Returns

`Promise`\<[`CurrentVersion`](CurrentVersion.md) \| `null`\>

***

### getVersion()

> **getVersion**(`objectId`, `versionId`, `options?`): `Promise`\<[`ObjectVersion`](ObjectVersion.md)\<`Response`\>\>

Reads fixed-version metadata and a streaming payload using two parallel requests.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`ObjectVersion`](ObjectVersion.md)\<`Response`\>\>

***

### getVersionMeta()

> **getVersionMeta**(`objectId`, `versionId`, `options?`): `Promise`\<[`VersionMeta`](VersionMeta.md)\>

Reads fixed-version metadata; a missing version throws.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`VersionMeta`](VersionMeta.md)\>

***

### listVersionHistory()

> **listVersionHistory**(`objectId`, `versionId`, `options?`): `Promise`\<[`VersionHistory`](VersionHistory.md)\>

Lists committed versions, not an ancestor graph; pagination is explicit.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`PageOptions`](PageOptions.md) |

#### Returns

`Promise`\<[`VersionHistory`](VersionHistory.md)\>

***

### getPayload()

> **getPayload**(`objectId`, `versionId`, `options?`): `Promise`\<`Response`\>

Returns a native Response; the caller consumes or cancels its body.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `versionId` | `string` |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<`Response`\>

***

### commit()

> **commit**(`input`, `options?`): `Promise`\<[`CommitResult`](CommitResult.md)\>

Submits fixed bytes and a CAS condition; content semantics belong to its object encoding.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`CommitInput`](CommitInput.md) |
| `options?` | [`RequestOptions`](RequestOptions.md) & `object` |

#### Returns

`Promise`\<[`CommitResult`](CommitResult.md)\>

***

### getIndex()

> **getIndex**(`options?`): `Promise`\<[`BucketIndex`](BucketIndex.md)\>

Reads current heads and a nullable feed cursor; absence is not deletion.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`BucketIndex`](BucketIndex.md)\>

***

### listFeed()

> **listFeed**(`options?`): `Promise`\<[`FeedPage`](FeedPage.md)\>

Reads one durable feed page; null cursor starts at the beginning.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`PageOptions`](PageOptions.md) |

#### Returns

`Promise`\<[`FeedPage`](FeedPage.md)\>

***

### watchFeed()

> **watchFeed**(`options?`): `AsyncGenerator`\<[`FeedEvent`](FeedEvent.md)\>

Opens one connection on iteration; yields ready before change hints, with no reconnect.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`AsyncGenerator`\<[`FeedEvent`](FeedEvent.md)\>
