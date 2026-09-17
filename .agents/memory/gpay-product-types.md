---
name: GPay product types
description: Verified GPay Partner API classification and catalog retrieval behavior.
---

GPay Partner API `ProductType` uses numeric value 1 for Steam Gift and 2 for Keys. Treat any other value as unknown and block publication rather than assuming it is a key.

GPay numeric product IDs are scoped by product type, not globally unique. The local identity must therefore include both ID and type.

**Why:** The unfiltered first catalog page contained only gifts, and key IDs can overlap gift IDs. Filtering one untyped catalog produced no keys, while global ID uniqueness discarded valid key records.

**How to apply:** Always pass a type to GPay. For “all,” fetch and paginate types 1 and 2 separately, deduplicate by type plus ID, and merge them. Retain an explicit unknown state for unexpected future values.