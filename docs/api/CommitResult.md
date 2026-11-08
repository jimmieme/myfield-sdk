[@myfield/sdk](index.md) / CommitResult

# Type Alias: CommitResult

> **CommitResult** = \{ `ok`: `true`; \} \| \{ `ok`: `false`; `reason`: `"version-mismatch"` \| `"conflict"`; \}

A write acknowledgement or normal CAS rejection; unknown results throw.
