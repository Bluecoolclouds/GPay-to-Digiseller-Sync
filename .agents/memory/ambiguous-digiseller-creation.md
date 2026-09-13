---
name: Ambiguous Digiseller creation
description: Safety rule for interrupted or timed-out external product creation when no Digiseller ID was persisted.
---

If a Digiseller creation attempt may have reached the external service but no returned product ID was persisted, keep the product in a non-retryable reconciliation-required state. Do not turn it into an ordinary retryable error.

**Why:** A timeout or process crash can happen after Digiseller creates the card but before the local database stores its ID. Repeating creation then produces a duplicate card.

**How to apply:** Serialize all publication paths per product, mark new-card creation as in progress before the external request, and require reconciliation before another creation attempt when that state survives without a Digiseller ID.