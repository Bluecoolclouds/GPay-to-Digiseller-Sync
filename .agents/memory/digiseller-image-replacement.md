---
name: Digiseller image replacement
description: Non-obvious behavior required to replace an existing product image rather than append another gallery entry.
---

Uploading a new product preview does not by itself replace the previous image. A forced regeneration must make the newly uploaded preview the first enabled image and remove the older image previews.

**Why:** Earlier fallback artwork can remain visible or primary when a new image is only appended to the gallery.

**How to apply:** Whenever the operator requests image replacement for an existing Digiseller card, treat upload, promotion, and removal of prior image previews as one operation. Keep failures visible and retryable.