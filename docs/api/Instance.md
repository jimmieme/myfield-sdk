[@myfield/sdk](index.md) / Instance

# Type Alias: Instance

> **Instance** = `object`

Application identity, Local-first bucket and default Remote resources.

## Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="appid"></a> `appId` | `readonly` | `string` | - |
| <a id="namespace"></a> `namespace` | `readonly` | `string` | - |
| <a id="instancekey"></a> `instanceKey` | `readonly` | [`InstanceKey`](InstanceKey.md) \| `null` | In-memory identity; null until supplied or restored/created by a Local auth operation. |
| <a id="bucket"></a> `bucket` | `readonly` | [`Bucket`](Bucket.md) | Stable default Local-first handle; access performs no I/O. |
| <a id="remote"></a> `remote` | `readonly` | [`Remote`](Remote.md) | Stable default protocol resources; direct use does not open storage. |

## Methods

### resume()

> **resume**(`options?`): `Promise`\<[`BucketState`](BucketState.md)\>

Restores saved identity/access and handles startup callbacks without prompting.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `bucketId?`: `string`; \} |
| `options.bucketId?` | `string` |

#### Returns

`Promise`\<[`BucketState`](BucketState.md)\>

***

### disconnect()

> **disconnect**(`options?`): `Promise`\<`void`\>

Stops sync and clears saved authorization; identity and local objects remain.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `bucketId?`: `string`; \} |
| `options.bucketId?` | `string` |

#### Returns

`Promise`\<`void`\>

***

### on()

> **on**(`event`, `handler`): () => `void`

Subscribes to default connection status/details; returns an unsubscribe function.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"state"` |
| `handler` | (`state`, `detail?`) => `void` |

#### Returns

() => `void`

***

### dispose()

> **dispose**(): `void`

Releases owned runtime work and cancels remote requests without deleting data.

#### Returns

`void`

***

### createBucket()

> **createBucket**(`options?`): [`Bucket`](Bucket.md)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `id?`: `string`; \} |
| `options.id?` | `string` |

#### Returns

[`Bucket`](Bucket.md)

***

### connect()

> **connect**(`options?`): `Promise`\<[`Authorization`](Authorization.md)\>

Reuses connected/saved access; opens authorization only when none is saved.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | [`ConnectOptions`](ConnectOptions.md) & `object` |

#### Returns

`Promise`\<[`Authorization`](Authorization.md)\>

***

### getSession()

> **getSession**(`options?`): `Promise`\<[`BearerCredential`](BearerCredential.md)\>

Loads saved access and obtains a session without prompting or consuming callback URLs.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `bucketId?`: `string`; `forceRefresh?`: `boolean`; \} |
| `options.bucketId?` | `string` |
| `options.forceRefresh?` | `boolean` |

#### Returns

`Promise`\<[`BearerCredential`](BearerCredential.md)\>
