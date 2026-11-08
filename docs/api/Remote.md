[@myfield/sdk](index.md) / Remote

# Interface: Remote

Default remote resources; bindings are in memory and never persisted automatically.

## Properties

### authBase

> **authBase**: `string`

***

### apiBase

> `readonly` **apiBase**: `string` \| `undefined`

***

### authorization

> `readonly` **authorization**: [`AuthorizationContext`](AuthorizationContext.md) \| `null`

***

### auth

> `readonly` **auth**: [`RemoteAuth`](RemoteAuth.md)

***

### bucket

> `readonly` **bucket**: [`BucketRemote`](BucketRemote.md)

## Methods

### bind()

> **bind**(`authorization`): `void`

Binds verified/restored access in memory; sessions are acquired on demand.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `authorization` | [`AuthorizationContext`](AuthorizationContext.md) |

#### Returns

`void`

***

### unbind()

> **unbind**(): `void`

Clears in-memory access without deleting saved authorization or revoking access.

#### Returns

`void`
