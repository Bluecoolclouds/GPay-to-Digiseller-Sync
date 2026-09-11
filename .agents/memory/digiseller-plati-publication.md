---
name: Digiseller Plati publication
description: Non-obvious reliability and localization requirements for publishing into the Plati catalog.
---

Plati category lookup is paginated and can have transient timeouts. Fetch pages in limited parallel batches, retry transient failures, normalize punctuation for matching, and only accept exact or prefix-compatible game names.

**Why:** A sequential lookup timed out before reaching the needed category. Once found, product creation was rejected because Plati requires both ru-RU and en-US localizations.

**How to apply:** Include ru-RU and en-US entries for localized product fields whenever a Plati-owned category is attached. Keep category matching conservative so a network optimization cannot silently assign an unrelated game.