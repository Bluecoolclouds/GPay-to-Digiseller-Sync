---
name: Digiseller state-change reconciliation
description: Safety rule for state-changing Digiseller requests that lose their response.
---

After a timeout or transport failure on a state-changing Digiseller request, treat the outcome as unknown and read the seller-visible state before committing the corresponding local transition.

**Why:** Digiseller may apply a mutation even when the client never receives its response. Retrying blindly or assuming failure can create duplicate or contradictory external state.

**How to apply:** Continue the local transition only when the external read confirms the intended state. If it confirms the old state or cannot establish the state, preserve the previous local state and return an actionable error.