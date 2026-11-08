[@myfield/sdk](index.md) / CommitSchema

# Type Alias: CommitSchema

> **CommitSchema** = `"current"` \| `"legacy"` \| \{ `encode`(`input`): \{ `body`: `Blob` \| `Uint8Array` \| `FormData`; `headers?`: `HeadersInit`; \}; \}

Request encoding for the same commit endpoint; payload encryption stays with callers.
