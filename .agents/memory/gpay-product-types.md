---
name: GPay product types
description: Verified GPay Partner API classification and catalog retrieval behavior.
---

GPay Partner API `ProductType` uses numeric value 1 for Steam Gift and 2 for Keys. Treat any other value as unknown and block publication rather than assuming it is a key.

**Why:** The unfiltered first catalog page contained only gifts, so filtering after fetching one page produced zero keys. The official Partner API Swagger confirms the enum and supports a server-side `productType` request field.

**How to apply:** Always pass a type to GPay. For “all,” fetch and paginate types 1 and 2 separately, then deduplicate and merge them. Retain an explicit unknown state for unexpected future values.