---
name: Existing Digiseller product linking
description: Safety rules for associating seller-account cards with local GPay products.
---

Existing Digiseller cards may be linked automatically only when the trimmed name is an exact, unique match on both the local and seller sides. Ambiguous or non-exact matches must be selected explicitly. Linking must share the per-product publication lock and atomically record historical ownership and the current association.

**Why:** The legacy site generated cards with names identical to the source catalog, so unique exact matches are safe and prevent duplicate publication. Names still are not stable identities when duplicated or changed. A concurrent publish can otherwise create an unintended extra card, and a partially committed ownership record can leave contradictory mappings after an error.

**How to apply:** Group both catalogs by trimmed exact name and auto-link only one-to-one groups. Treat current and historical Digiseller IDs as exclusive to one local product. Reject implicit reassignment; use manual selection for ambiguous names.