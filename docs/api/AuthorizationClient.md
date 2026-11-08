[@myfield/sdk](index.md) / AuthorizationClient

# Interface: AuthorizationClient

Authorization flow independent of durable storage and bucket HTTP operations.

## Methods

### createRequest()

> **createRequest**(`options?`): [`AuthorizationRequest`](AuthorizationRequest.md)

Builds a same-tab request without navigating or persisting anything.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `bucketId?`: `string`; \} |
| `options.bucketId?` | `string` |

#### Returns

[`AuthorizationRequest`](AuthorizationRequest.md)

***

### handleCallback()

> **handleCallback**(`url`, `request`): `Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>

Validates/decrypts a callback against retained request state; performs no writes.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` |
| `request` | [`AuthorizationRequest`](AuthorizationRequest.md) |

#### Returns

`Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>

***

### authorize()

> **authorize**(`options?`): `Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>

Opens a popup from a user action and returns the verified context/key; never persists it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `bucketId?`: `string`; `signal?`: `AbortSignal`; \} |
| `options.bucketId?` | `string` |
| `options.signal?` | `AbortSignal` |

#### Returns

`Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>
