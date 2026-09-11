---
name: Digiseller product type for manual fulfillment
description: Which Digiseller product type supports safe manual fulfillment forms.
---

Use an `Arbitrary` Digiseller product with `Form` content for Steam Gift items that require buyer details. For key items, use `UniqueFixed` with `text` content stocked with bilingual notices that the key will arrive in chat within five minutes.

**Why:** Digiseller rejects `Form` content for `UniqueFixed` products. The operator explicitly chose immediate Text delivery notices while the actual key is fulfilled manually in chat.

**How to apply:** Keep gifts on Form. Give each key product multiple Text notice units because Digiseller consumes one unit per sale. Replace legacy key Form cards with new Text cards, and disable the old card only after the new card has content and an image.

For Plati.Market, do not pass IDs from the legacy marketplace category tree to the old add-category endpoint. Find the exact game in the authenticated cataloguer tree, then edit/create the product with a category entry whose owner is `1` and whose cataloguer category ID is the exact game category.

**Why:** Legacy tree IDs return “Category not found.” A cataloguer-owned Plati category produces a real `plati.market/itm/...` card with marketplace ownership.

**How to apply:** Search the Games cataloguer root for the exact title, attach owner `1`, and verify the resulting public card URL.

When the seller account rejects the exact cataloguer category, do not substitute a category based on the product name. Save an operator-verified marketplace category override for that product, create the uncategorized Digiseller card first, and validate the explicit category assignment separately.

**Why:** Category acceptance depends on the seller account. Creating the card before assignment preserves its Digiseller ID when category validation fails, so retries update the same card instead of creating duplicates.

**How to apply:** Reuse the saved override on later publications and only mark the product published after Digiseller confirms the category assignment.