[@myfield/sdk](index.md) / AuthorizationStorage

# Interface: AuthorizationStorage

Explicit storage for cloneable identity, pending request and authorization records.

## Methods

### get()

> **get**\<`T`\>(`key`): `Promise`\<`T` \| `null`\>

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| <a id="gett"></a> `T` | `unknown` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`Promise`\<`T` \| `null`\>

***

### set()

> **set**(`key`, `value`): `Promise`\<`void`\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `value` | `unknown` |

#### Returns

`Promise`\<`void`\>

***

### add()

> **add**(`key`, `value`): `Promise`\<`boolean`\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `value` | `unknown` |

#### Returns

`Promise`\<`boolean`\>

***

### remove()

> **remove**(`key`): `Promise`\<`void`\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`Promise`\<`void`\>

***

### keys()

> **keys**(`prefix`): `Promise`\<`string`[]\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `prefix` | `string` |

#### Returns

`Promise`\<`string`[]\>
