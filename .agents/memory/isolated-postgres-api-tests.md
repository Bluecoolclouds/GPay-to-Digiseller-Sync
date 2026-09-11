---
name: Isolated PostgreSQL API tests
description: How to keep API integration tests from mutating the operator database when using Drizzle and PostgreSQL schemas.
---

Create a uniquely named PostgreSQL schema for each API test run, set the child process `search_path` to it, and create the required test tables explicitly in that schema.

**Why:** Drizzle Kit schema push reported no changes after connecting with a schema-specific `search_path` because it inspected the existing public schema. Tests then connected to an empty isolated schema.

**How to apply:** For integration tests that use the real database layer, fail closed unless `current_schema()` matches the generated test schema. Drop that exact schema after the test process exits.