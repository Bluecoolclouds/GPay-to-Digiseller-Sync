---
name: API integration-test isolation
description: Non-obvious isolation rules for API suites that combine database fixtures, local HTTP calls, and outbound request mocks.
---

Give each database-backed test suite its own temporary schema. Route requests to the suite's local server through the captured native fetch implementation, not through the mutable outbound-service mock, and restore mock state after each test.

**Why:** A local API request can be intercepted by an outbound mock and fail before cleanup. The leftover database row then makes later rollback tests look broken even when their transactions are correct.

**How to apply:** Use these boundaries whenever a suite starts a local server while also replacing global fetch or sharing database fixture tables.