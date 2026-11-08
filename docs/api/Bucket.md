[@myfield/sdk](index.md) / Bucket

# Type Alias: Bucket

> **Bucket** = `object`

Local object storage with authorization and encrypted synchronization.

## Properties

| Property | Modifier | Type |
| ------ | ------ | ------ |
| <a id="id"></a> `id` | `readonly` | `string` |
| <a id="state"></a> `state` | `readonly` | [`BucketState`](BucketState.md) |

## Methods

### binary()

> **binary**(`input`, `options?`): [`BucketBinaryValue`](BucketBinaryValue.md)

Creates a local binary handle without uploading it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`BinaryInput`](BinaryInput.md) \| [`BucketBinaryValue`](BucketBinaryValue.md) |
| `options?` | [`BinaryOptions`](BinaryOptions.md) |

#### Returns

[`BucketBinaryValue`](BucketBinaryValue.md)

***

### ~~ready()~~

> **ready**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Deprecated

No-op. Storage initializes on the first data operation.

***

### put()

> **put**(`objectId`, `object`): `Promise`\<`void`\>

Replaces a local object; omitted fields are removed.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `object` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`objectId`): `Promise`\<`Record`\<`string`, `unknown`\> \| `null`\>

Reads a local object, returning null when missing or deleted.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\> \| `null`\>

***

### update()

> **update**(`objectId`, `fields`): `Promise`\<`void`\>

Updates supplied fields; undefined removes a field.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |
| `fields` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

### delete()

> **delete**(`objectId`): `Promise`\<`void`\>

Marks a local object deleted for synchronization.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `objectId` | `string` |

#### Returns

`Promise`\<`void`\>

***

### list()

> **list**(`options?`): `Promise`\<[`ListEntry`](ListEntry.md)[]\>

Lists local index entries, optionally including deleted objects.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `prefix?`: `string`; `includeDeleted?`: `boolean`; \} |
| `options.prefix?` | `string` |
| `options.includeDeleted?` | `boolean` |

#### Returns

`Promise`\<[`ListEntry`](ListEntry.md)[]\>

***

### resume()

> **resume**(): `Promise`\<[`BucketState`](BucketState.md)\>

Restores saved authorization and handles an authorization callback.

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### ~~connect()~~

> **connect**(`options?`): `Promise`\<[`BucketState`](BucketState.md)\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`ConnectOptions`](ConnectOptions.md) |

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

#### Deprecated

Use instance.connect(); this compatibility entry returns state on authorization failure.

***

### ~~disconnect()~~

> **disconnect**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Deprecated

Use instance.disconnect(); local objects remain.

***

### sync()

> **sync**(): `Promise`\<`void`\>

Runs a synchronization pass when connected.

#### Returns

`Promise`\<`void`\>

***

### setAutoSync()

> **setAutoSync**(`enabled`): `void`

Enables or disables automatic synchronization.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `enabled` | `boolean` |

#### Returns

`void`

***

### on()

#### Call Signature

> **on**(`event`, `handler`): () => `void`

Subscribes to connection state; returns an unsubscribe function.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"state"` |
| `handler` | (`state`, `detail?`) => `void` |

##### Returns

() => `void`

#### Call Signature

> **on**(`event`, `handler`): () => `void`

Subscribes to local object changes, including applied remote changes; returns an unsubscribe function.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"change"` |
| `handler` | (`objectId`) => `void` |

##### Returns

() => `void`

***

### dispose()

> **dispose**(): `void`

Stops background work and releases bucket resources.

#### Returns

`void`
