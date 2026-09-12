---
name: Supplier availability retries
description: Safe ordering for synchronizing supplier availability with marketplace sales state.
---

Persist a published product's transition to unavailable only after the marketplace confirms that its card was disabled. A failed disable must leave the prior local availability intact so the next synchronization sees the transition and retries it.

**Why:** Saving unavailable before a failed marketplace call suppresses later retries and can leave a purchasable card active indefinitely.

**How to apply:** Use this ordering for supplier-to-marketplace availability changes. Re-enable only after the supplier catalog explicitly confirms availability; absence from a complete catalog counts as unavailable, not available.