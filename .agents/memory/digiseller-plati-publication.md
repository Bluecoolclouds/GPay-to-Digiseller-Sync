---
name: Digiseller Plati publication
description: Non-obvious reliability and localization requirements for publishing into the Plati catalog.
---

Plati category lookup is paginated and can have transient timeouts. Fetch pages in limited parallel batches, retry transient failures, normalize punctuation for matching, and only accept exact or prefix-compatible game names.

Marketplace dictionary entries marked `can_add` are not guaranteed to be assignable through the product category API for this seller. A cataloguer category may also exist but be restricted for the account. Preserve the created Digiseller ID before category assignment so retries cannot create duplicates.

Arbitrary product creation rejects an empty category list with `category-0`. A verified marketplace category must be included in the create/edit payload as `{ owner: 0, category_id }`; do not defer all category assignment until after creation.

Cataloguer attribute IDs and values are category-specific. Fetch them from the selected category and fill Platform, Content type, and Edition only from returned values; match editions only when explicitly present in the product title.

**Why:** A sequential lookup timed out before reaching the needed category. Once found, product creation was rejected because Plati requires both ru-RU and en-US localizations. For WoW game time, both the exact subscription leaf and an approved general WoW leaf appeared addable in the public dictionary but the live category API rejected them as not found. Live creation also proved that category assignment is mandatory at creation time. A live V Rising category showed that Platform, Content type, and Edition use IDs defined by that category rather than global constants.

**How to apply:** Include ru-RU and en-US entries for localized product fields whenever a Plati-owned category is attached. Keep category and attribute matching conservative. Send manually verified marketplace IDs as owner 0 during creation; a rejected create has no product ID to preserve. Require manual category selection when the seller rejects all exact safe categories.