---
name: Fulfillment crash recovery
description: Recovery rule for fulfillment split across supplier purchase and marketplace delivery.
---

Treat supplier purchase persistence and marketplace delivery confirmation as separate crash boundaries. Recovery must select every durable intermediate delivery state, including queued, not only null or failed.

**Why:** A process can exit after the paid supplier result is committed but before marketplace delivery starts. Excluding the queued state strands a purchased key even though no retry of the purchase is safe or necessary.

**How to apply:** Whenever fulfillment spans multiple external systems or commits, enumerate all persisted states reachable at each exit point and cover each one with restart-oriented integration tests.