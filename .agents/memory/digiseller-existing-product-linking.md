---
name: Existing Digiseller product linking
description: Safety rules for associating seller-account cards with local GPay products.
---

Existing Digiseller cards must be selected explicitly rather than matched automatically by name. Linking must share the per-product publication lock and atomically record historical ownership, the current association, and its activity event.

**Why:** Product names are not stable identities. A concurrent publish can otherwise create an unintended extra card, and a partially committed ownership record can leave contradictory mappings after an error.

**How to apply:** Treat both current and historical Digiseller IDs as exclusive to one local product. Reject implicit reassignment; make remapping a separate explicit operation if it is ever needed.