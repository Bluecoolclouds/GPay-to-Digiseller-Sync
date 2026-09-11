---
name: Digiseller bulk price tasks
description: Live response behavior and terminal statuses for asynchronous bulk price updates.
---

Accept the bulk price update response as either documented JSON or a plain UUID string. Poll the returned task until status `3` for completion; status `2` is a terminal error, not success.

**Why:** The live API returned the task UUID as unquoted text, and treating documented status `2` as completion caused successful jobs to wait until timeout. Official status meanings are `0` queued, `1` in progress, `2` error, and `3` done.

**How to apply:** Use the dedicated bulk price endpoint, support both task-ID response formats, preserve per-product errors, and do not commit a published product's local price until Digiseller confirms the update.