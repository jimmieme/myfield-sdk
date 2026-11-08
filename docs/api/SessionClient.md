[@myfield/sdk](index.md) / SessionClient

# Interface: SessionClient

Creates sessions using a bound identity; no storage, refresh or retry.

## Extended by

- [`RemoteAuth`](RemoteAuth.md)

## Methods

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
