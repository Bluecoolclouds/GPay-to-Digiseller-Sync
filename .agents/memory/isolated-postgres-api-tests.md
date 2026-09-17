---
name: Isolated PostgreSQL API tests
description: How to keep API integration tests from mutating the operator database when using Drizzle and PostgreSQL schemas.
---

Create a uniquely named PostgreSQL schema for each API test run, set the child process `search_path` to it, and build it from SQL exported from the canonical Drizzle schema.

**Why:** A handwritten test DDL copy drifted from application constraints. Drizzle Kit schema push cannot safely target the test namespace because it may inspect public, while schema export is database-independent.

**How to apply:** Export the schema during the test build and execute it transactionally after setting a local `search_path`. Drizzle qualifies default PostgreSQL enums as public, so remove only that generated qualifier and reject any remaining public target. Fail closed unless `current_schema()` matches the generated test schema, then drop that exact schema after tests.

Database advisory locks are cluster-wide and are not isolated by PostgreSQL schema.

**Why:** A test using an isolated schema still collided with the running development scheduler because both used the same fixed advisory-lock ID, causing the test sync to be silently skipped.

**How to apply:** Derive a deterministic lock namespace from the isolated test schema while keeping stable production lock IDs. Explicitly assert `skipped: false` in tests whose behavior depends on acquiring the lock.