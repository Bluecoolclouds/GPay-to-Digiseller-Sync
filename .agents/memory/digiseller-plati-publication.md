---
name: Digiseller Plati publication
description: Non-obvious reliability and localization requirements for publishing into the Plati catalog.
---

Plati category lookup is paginated and can have transient timeouts. Fetch pages in limited parallel batches, retry transient failures, normalize punctuation for matching, and only accept exact or prefix-compatible game names.

Marketplace dictionary entries marked `can_add` are not guaranteed to be assignable through the product category API for this seller. A cataloguer category may also exist but be restricted for the account. Preserve the created Digiseller ID before category assignment so retries cannot create duplicates.

**Why:** A sequential lookup timed out before reaching the needed category. Once found, product creation was rejected because Plati requires both ru-RU and en-US localizations. For WoW game time, both the exact subscription leaf and an approved general WoW leaf appeared addable in the public dictionary but the live category API rejected them as not found.

**How to apply:** Include ru-RU and en-US entries for localized product fields whenever a Plati-owned category is attached. Keep category matching conservative, store IDs from partially completed creation, and require manual category assignment when the seller account rejects all exact safe categories.