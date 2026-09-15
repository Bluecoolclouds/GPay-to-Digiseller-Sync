---
name: GPay key purchase idempotency
description: Safety rule for key-order creation and status reconciliation when GPay calls time out.
---

Claim each purchase attempt durably before calling the GPay wholesale key-order endpoint. Once creation starts, never issue another create call for that marketplace order. If GPay returned a `uniqueCode`, reconcile only through the status endpoint. If creation timed out before returning a code, keep the result unknown and require manual investigation rather than risking a second charge.

**Why:** The official wholesale key-order request has no client-supplied idempotency key. A timed-out POST may have charged the balance even when its response never reached this service.

**How to apply:** Any retry, scheduler, operator action, or recovery flow must distinguish status reconciliation from order creation. Automatic retries are allowed only for status reads identified by the persisted GPay `uniqueCode`.

Treat fulfillment as a separate, retryable phase after purchase. Bind every GPay status response to the exact persisted `uniqueCode`, and authorize Digiseller delivery only after its unique-code lookup matches both the invoice and product with a known eligible state. Preserve that verified binding when rotating the buyer link.

**Why:** Provider success responses and link rotation must not be allowed to associate a purchased secret with a different order or bypass the buyer-code verification gate.

**How to apply:** Fail closed on missing or conflicting provider identity/state fields. Persist delivered secrets encrypted, and expose them only through a token for the already verified marketplace order.