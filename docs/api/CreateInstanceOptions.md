[@myfield/sdk](index.md) / CreateInstanceOptions

# Type Alias: CreateInstanceOptions

> **CreateInstanceOptions** = `object`

Local instance namespace and storage settings.

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="namespace"></a> `namespace?` | `string` | - |
| <a id="storage"></a> `storage?` | `"indexeddb"` \| `"memory"` | - |
| <a id="authstorage"></a> `authStorage?` | [`AuthStorage`](AuthStorage.md) | Optional application-owned authorization store; omitted preserves existing storage. |
| <a id="instancekey"></a> `instanceKey?` | [`InstanceKey`](InstanceKey.md) | An existing identity to persist only if this scope has no identity yet. |
| <a id="authbase"></a> `authBase?` | `string` | Initial authorization page; connect options may override it. |
| <a id="fetch"></a> `fetch?` | *typeof* `globalThis.fetch` | - |
