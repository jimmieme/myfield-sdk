[@myfield/sdk](index.md) / Authorization

# Type Alias: Authorization

> **Authorization** = `Readonly`\<[`AuthorizationContext`](AuthorizationContext.md)\> & `object`

Authorized bucket binding; credentials are obtained on demand.

## Type Declaration

### getSession()

> **getSession**(`options?`): `Promise`\<[`BearerCredential`](BearerCredential.md)\>

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | \{ `forceRefresh?`: `boolean`; \} |
| `options.forceRefresh?` | `boolean` |

#### Returns

`Promise`\<[`BearerCredential`](BearerCredential.md)\>
