---
name: Digiseller product images
description: Durable image-publication workflow for products sourced from GPay.
---

Digiseller product creation does not include gallery images. Upload the image afterward with the official multipart product preview endpoint. If GPay supplies no image, use a clearly labeled generated product cover rather than guessing artwork from a title.

**Why:** The observed keys catalog had no GPay images or Steam App IDs, so reliable automatic matching to real game artwork was impossible. Images are still required for usable marketplace cards.

**How to apply:** Prefer a valid GPay image, otherwise generate a neutral cover from the product name, type, and region. Track successful gallery upload separately so retries update the existing Digiseller card without duplicating it.