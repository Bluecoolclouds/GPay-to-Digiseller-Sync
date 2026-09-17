import assert from "node:assert/strict";
import test from "node:test";
import { backgroundJobStateTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listBackgroundJobHealth,
  recordWorkerHeartbeat,
  runBackgroundJob,
  startBackgroundWorker,
} from "../lib/background-worker";

test.afterEach(async () => {
  await db.delete(backgroundJobStateTable);
});

test("concurrent worker instances execute a job only once", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const callbackStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const first = runBackgroundJob(
    "purchase-reconciliation",
    60,
    async () => {
      calls++;
      started();
      await gate;
      return { checked: 1 };
    },
    { force: true },
  );
  await callbackStarted;
  const second = await runBackgroundJob(
    "purchase-reconciliation",
    60,
    async () => {
      calls++;
      return { checked: 2 };
    },
    { force: true },
  );
  release();
  const completed = await first;

  assert.equal(calls, 1);
  assert.equal(second.status, "locked");
  assert.equal(completed.status, "completed");
});

test("heartbeat remains fresh while a job is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = startBackgroundWorker({
    tickMs: 1_000,
    heartbeatMs: 10,
    runTick: async () => gate,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    const [scheduler] = await db
      .select()
      .from(backgroundJobStateTable)
      .where(eq(backgroundJobStateTable.name, "scheduler"));
    assert(scheduler.lastHeartbeatAt);
    assert(Date.now() - scheduler.lastHeartbeatAt.getTime() < 100);
  } finally {
    release();
    stop();
  }
});

test("an interrupted run is resumed after its advisory lock disappears", async () => {
  const oldStartedAt = new Date(Date.now() - 10 * 60 * 1_000);
  await db.insert(backgroundJobStateTable).values({
    name: "order-sync",
    intervalSeconds: 300,
    lastStartedAt: oldStartedAt,
  });
  let calls = 0;
  const result = await runBackgroundJob("order-sync", 300, async () => {
    calls++;
    return { recovered: true };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
});

test("temporary provider failure is persisted and remains retryable", async () => {
  await assert.rejects(
    runBackgroundJob(
      "price-sync",
      3600,
      async () => {
        throw new Error("supplier temporarily unavailable");
      },
      { force: true },
    ),
    /temporarily unavailable/,
  );
  const [failed] = await db
    .select()
    .from(backgroundJobStateTable)
    .where(eq(backgroundJobStateTable.name, "price-sync"));
  assert.equal(failed.consecutiveFailures, 1);
  assert.match(failed.lastError ?? "", /temporarily unavailable/);

  const retried = await runBackgroundJob(
    "price-sync",
    3600,
    async () => ({ checked: 0 }),
    { force: true },
  );
  assert.equal(retried.status, "completed");
  const [recovered] = await db
    .select()
    .from(backgroundJobStateTable)
    .where(eq(backgroundJobStateTable.name, "price-sync"));
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastError, null);
});

test("a skipped run does not erase a previous failure", async () => {
  await assert.rejects(
    runBackgroundJob(
      "price-sync",
      3600,
      async () => {
        throw new Error("supplier outage");
      },
      { force: true },
    ),
  );
  const skipped = await runBackgroundJob(
    "price-sync",
    3600,
    async () => ({ skipped: true }),
    { force: true },
  );
  assert.equal(skipped.status, "skipped");
  const [state] = await db
    .select()
    .from(backgroundJobStateTable)
    .where(eq(backgroundJobStateTable.name, "price-sync"));
  assert.equal(state.consecutiveFailures, 1);
  assert.match(state.lastError ?? "", /supplier outage/);
  assert.equal(state.lastSuccessfulAt, null);
});

test("operator health marks a stopped scheduler and stale job", async () => {
  const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
  await recordWorkerHeartbeat(old);
  await db.insert(backgroundJobStateTable).values({
    name: "price-sync",
    intervalSeconds: 3600,
    lastHeartbeatAt: old,
    lastStartedAt: old,
    lastSuccessfulAt: old,
    lastFinishedAt: old,
  });
  const health = await listBackgroundJobHealth();
  assert.equal(health.find((item) => item.name === "scheduler")?.isStale, true);
  assert.equal(health.find((item) => item.name === "price-sync")?.isStale, true);
});