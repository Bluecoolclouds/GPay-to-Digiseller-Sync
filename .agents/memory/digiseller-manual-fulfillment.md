---
name: Digiseller product type for manual fulfillment
description: Which Digiseller product type supports safe manual fulfillment forms.
---

Use an `Arbitrary` Digiseller product with `Form` content when a GPay-backed item requires manual fulfillment.

**Why:** Digiseller rejects `Form` content for `UniqueFixed` products. `Arbitrary` accepts it and avoids delivering placeholder text as if it were a real key.

**How to apply:** Use the arbitrary-product creation endpoint for both Steam Gift and key products until real post-sale purchasing and content delivery are implemented.