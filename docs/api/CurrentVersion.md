[@myfield/sdk](index.md) / CurrentVersion

# Type Alias: CurrentVersion

> **CurrentVersion** = `object`

Current head with optional ancestry evidence requested by have.

## Indexable

> \[`field`: `string`\]: `unknown`

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="versionid"></a> `versionId` | `string` | - |
| <a id="headversionmeta"></a> `headVersionMeta` | [`VersionMeta`](VersionMeta.md) | - |
| <a id="history"></a> `history?` | `string`[] \| `null` | Non-empty proves ancestry; [] is no stored proof; null is incomplete or bounded evidence. |
