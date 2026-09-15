import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

const schema = `sync_product_types_test_${randomBytes(8).toString("hex")}`;
assert.match(schema, /^sync_product_types_test_[a-f0-9]+$/);

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
databaseUrl.searchParams.set("options", `-c search_path=${schema}`);

const compiledDir = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.join(compiledDir, "sync-product-types.test.mjs");
const priceTaskTestFile = path.join(compiledDir, "digiseller-price-tasks.test.mjs");
const publicOrdersTestFile = path.join(compiledDir, "public-orders.test.mjs");

const authTestFile = path.join(compiledDir, "auth.test.mjs");
const isolatedEnvironment = {
  ...process.env,
  DATABASE_URL: databaseUrl.toString(),
  TEST_DATABASE_SCHEMA: schema,
  TEST_AUTH_BYPASS: "1",
};

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: isolatedEnvironment,
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

run(process.execPath, ["--test", priceTaskTestFile]);

try {
  await pool.query(`create schema "${schema}"`);
  await pool.query(`
    create table "${schema}".sync_settings (
      id integer primary key default 1,
      default_margin_percent double precision not null default 15,
      usd_rub_rate double precision not null default 92,
      exchange_rate_mode text not null default 'cbr',
      conversion_markup_percent double precision not null default 2,
      digiseller_fee_percent double precision not null default 5,
      fixed_reserve_rub double precision not null default 30,
      minimum_profit_rub double precision not null default 100,
      automation_mode text not null default 'manual',
      disable_on_unavailable boolean not null default true,
      updated_at timestamptz not null default now()
    );
    create table "${schema}".sync_products (
      id serial primary key,
      gpay_id integer not null unique,
      digiseller_id integer,
      previous_digiseller_id integer,
      digiseller_delivery_type text,
      digiseller_text_stocked boolean not null default false,
      plati_category_id integer,
      app_id integer,
      sub_id integer,
      name text not null,
      image_url text,
      digiseller_image_uploaded boolean not null default false,
      product_type text not null,
      supplier_price_usd double precision not null,
      sale_price_rub double precision not null,
      margin_percent double precision not null,
      profit_rub double precision not null,
      is_available boolean not null default false,
      publication_status text not null default 'draft',
      publication_error text,
      publication_failure_stage text,
      region text not null default 'Не указан',
      warning_message text,
      updated_at timestamptz not null default now()
    );
    create table "${schema}".sync_activities (
      id serial primary key,
      type text not null,
      title text not null,
      description text not null,
      status text not null,
      created_at timestamptz not null default now()
    );
    create table "${schema}".sync_publication_jobs (
      id uuid primary key,
      status text not null default 'queued',
      product_ids integer[] not null,
      items jsonb not null default '[]'::jsonb,
      requested integer not null,
      succeeded integer not null default 0,
      failed integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      completed_at timestamptz
    );
    create table "${schema}".sync_orders (
      id serial primary key,
      invoice_id text not null unique,
      digiseller_product_id integer not null,
      product_name text not null,
      paid_amount_rub double precision,
      sale_timestamp timestamptz not null,
      status text not null default 'new',
      is_returned boolean not null default false,
      operator_note text,
      public_token_hash text unique,
      public_link_expires_at timestamptz,
      public_code_encrypted text,
      public_opened_at timestamptz,
      public_submitted_at timestamptz,
      public_submitted_code_hash text,
      public_submission_error text,
      synced_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table "${schema}".sync_product_digiseller_ids (
      id serial primary key,
      local_product_id integer not null,
      digiseller_product_id integer not null unique,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      unique (local_product_id, digiseller_product_id)
    );
    create table "${schema}".sync_order_state (
      id integer primary key default 1,
      cursor_at timestamptz,
      last_attempt_at timestamptz,
      consecutive_failures integer not null default 0,
      last_error text,
      updated_at timestamptz not null default now()
    );
  `);
  run(process.execPath, ["--test", publicOrdersTestFile]);
  run(process.execPath, ["--test", testFile]);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`);
  await pool.end();
  await rm(compiledDir, { recursive: true, force: true });
}
