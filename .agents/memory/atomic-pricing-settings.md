---
name: Atomic pricing settings
description: Why pricing-rule activation and Digiseller price updates must share one serialized apply boundary.
---

Pricing settings are active only when the corresponding published prices have been confirmed by Digiseller. Serialize the full apply operation with the price-sync lock; on any external or local commit failure, keep the previous settings and local prices and roll remote changes back. Disable cards whose rollback result is uncertain.

**Why:** Activating rules or overwriting local prices first can make later synchronization see no difference, leaving old unsafe prices live indefinitely. Concurrent saves can also mix one preview's rate with another request's settings.

**How to apply:** Any new endpoint or background process that changes effective exchange rates, fees, margins, reserves, or profit floors must use the same atomic apply boundary. Read-only rate endpoints must not activate a rate.