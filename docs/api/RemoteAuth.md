[@myfield/sdk](index.md) / RemoteAuth

# Interface: RemoteAuth

Authorization requests and session exchange using the owning Instance identity.

## Extends

- [`SessionClient`](SessionClient.md)

## Methods

### authorize()

#### Call Signature

> **authorize**(`options?`): `Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>

Starts a popup authorization and returns verified access without saving or binding it.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `mode?`: `"popup"`; `bucketId?`: `string`; `signal?`: `AbortSignal`; \} |
| `options.mode?` | `"popup"` |
| `options.bucketId?` | `string` |
| `options.signal?` | `AbortSignal` |

##### Returns

`Promise`\<[`AuthorizationContext`](AuthorizationContext.md)\>

#### Call Signature

> **authorize**(`options`): `Promise`\<`void`\>

Saves pending state and the identity before navigating in this tab.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `mode`: `"redirect"`; `bucketId?`: `string`; `signal?`: `AbortSignal`; \} |
| `options.mode` | `"redirect"` |
| `options.bucketId?` | `string` |
| `options.signal?` | `AbortSignal` |

##### Returns

`Promise`\<`void`\>

#### Call Signature

> **authorize**(`options`): `Promise`\<`void` \| [`AuthorizationContext`](AuthorizationContext.md)\>

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | \{ `mode`: `"popup"` \| `"redirect"`; `bucketId?`: `string`; `signal?`: `AbortSignal`; \} |
| `options.mode` | `"popup"` \| `"redirect"` |
| `options.bucketId?` | `string` |
| `options.signal?` | `AbortSignal` |

##### Returns

`Promise`\<`void` \| [`AuthorizationContext`](AuthorizationContext.md)\>

***

### handleCallback()

> **handleCallback**(): `Promise`\<[`AuthorizationContext`](AuthorizationContext.md) \| `null`\>

Restores a same-tab callback from the current URL; returns null when absent.

#### Returns

`Promise`\<[`AuthorizationContext`](AuthorizationContext.md) \| `null`\>

***

### createSession()

> **createSession**(`input`, `options?`): `Promise`\<[`InstanceSession`](InstanceSession.md)\>

Requests a challenge, signs it and exchanges the proof for a bearer session.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | [`InstanceSessionInput`](InstanceSessionInput.md) |
| `options?` | [`RequestOptions`](RequestOptions.md) |

#### Returns

`Promise`\<[`InstanceSession`](InstanceSession.md)\>

#### Inherited from

[`SessionClient`](SessionClient.md).[`createSession`](SessionClient.md#createsession)
