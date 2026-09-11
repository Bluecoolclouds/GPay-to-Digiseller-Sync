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
const isolatedEnvironment = {
  ...process.env,
  DATABASE_URL: databaseUrl.toString(),
  TEST_DATABASE_SCHEMA: schema,
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

try {
  run(process.execPath, ["--test", priceTaskTestFile]);
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
  `);
  run(process.execPath, ["--test", testFile]);
} finally {
  await pool.query(`drop schema if exists "${schema}" cascade`);
  await pool.end();
  await rm(compiledDir, { recursive: true, force: true });
}