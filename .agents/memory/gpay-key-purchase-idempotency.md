---
name: GPay key purchase idempotency
description: Safety rule for key-order creation and status reconciliation when GPay calls time out.
---

Claim each purchase attempt durably before calling the GPay wholesale key-order endpoint. Once creation starts, never issue another create call for that marketplace order. If GPay returned a `uniqueCode`, reconcile only through the status endpoint. If creation timed out before returning a code, keep the result unknown and require manual investigation rather than risking a second charge.

**Why:** The official wholesale key-order request has no client-supplied idempotency key. A timed-out POST may have charged the balance even when its response never reached this service.

**How to apply:** Any retry, scheduler, operator action, or recovery flow must distinguish status reconciliation from order creation. Automatic retries are allowed only for status reads identified by the persisted GPay `uniqueCode`.