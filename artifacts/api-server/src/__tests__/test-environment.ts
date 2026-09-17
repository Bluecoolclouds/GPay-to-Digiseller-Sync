import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

const schemaSuffix = randomBytes(8).toString("hex");
const syncSchema = `sync_product_types_test_${schemaSuffix}`;
const publicOrdersSchema = `public_orders_test_${schemaSuffix}`;
const backgroundWorkerSchema = `background_worker_test_${schemaSuffix}`;
assert.match(syncSchema, /^sync_product_types_test_[a-f0-9]+$/);
assert.match(publicOrdersSchema, /^public_orders_test_[a-f0-9]+$/);
assert.match(backgroundWorkerSchema, /^background_worker_test_[a-f0-9]+$/);

const compiledDir = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = await readFile(path.join(compiledDir, "schema.sql"), "utf8");
assert.doesNotMatch(
  schemaSql,
  /"public"\./,
  "Generated test schema SQL must not target the public schema",
);
const testFile = path.join(compiledDir, "sync-product-types.test.mjs");
const priceTaskTestFile = path.join(compiledDir, "digiseller-price-tasks.test.mjs");
const publicOrdersTestFile = path.join(compiledDir, "public-orders.test.mjs");
const backgroundWorkerTestFile = path.join(compiledDir, "background-worker.test.mjs");

const authTestFile = path.join(compiledDir, "auth.test.mjs");
function environmentFor(schema: string) {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
  return {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
    TEST_DATABASE_SCHEMA: schema,
    TEST_AUTH_BYPASS: "1",
  };
}

const isolatedEnvironment = environmentFor(syncSchema);

function run(command: string, args: string[], env = isolatedEnvironment) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

const { TEST_AUTH_BYPASS: _bypass, ...authEnvironment } = isolatedEnvironment;
const authResult = spawnSync(process.execPath, ["--test", authTestFile], {
  cwd: process.cwd(),
  env: authEnvironment,
  stdio: "inherit",
});
if (authResult.error) throw authResult.error;
if (authResult.status !== 0) throw new Error("Auth middleware tests failed");

run(process.execPath, ["--test", "--test-concurrency=1", priceTaskTestFile]);

async function createTestSchema(schema: string) {
  assert.match(schema, /^[a-z0-9_]+$/);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(schemaSql);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

try {
  await createTestSchema(publicOrdersSchema);
  await createTestSchema(backgroundWorkerSchema);
  await createTestSchema(syncSchema);
  run(
    process.execPath,
    ["--test", "--test-concurrency=1", publicOrdersTestFile],
    environmentFor(publicOrdersSchema),
  );
  run(
    process.execPath,
    ["--test", "--test-concurrency=1", backgroundWorkerTestFile],
    environmentFor(backgroundWorkerSchema),
  );
  run(process.execPath, ["--test", "--test-concurrency=1", testFile]);
} finally {
  await pool.query(`drop schema if exists "${publicOrdersSchema}" cascade`);
  await pool.query(`drop schema if exists "${backgroundWorkerSchema}" cascade`);
  await pool.query(`drop schema if exists "${syncSchema}" cascade`);
  await pool.end();
  await rm(compiledDir, { recursive: true, force: true });
}
