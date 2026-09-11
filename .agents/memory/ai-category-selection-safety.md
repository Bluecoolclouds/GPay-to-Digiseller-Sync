---
name: AI category selection safety
description: Validation constraints for using apinet gpt-5.5 to select Plati categories.
---

Give the model only a shortlist of real category IDs and names. Accept either a high-confidence `categoryId` or exactly one supplied candidate explicitly marked as a match; reject all other output.

**Why:** The live model ignored the requested schema even with JSON mode, returning a different valid JSON structure. Category IDs affect live marketplace placement, so invented or ambiguous IDs are unsafe.

**How to apply:** Run deterministic matching first, use AI only when no category is found, validate every returned ID against the supplied shortlist, and preserve a null/no-match result.