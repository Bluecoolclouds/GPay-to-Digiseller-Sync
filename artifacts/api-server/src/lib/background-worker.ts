import { backgroundJobStateTable, db, pool, type BackgroundJobName } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { syncDigisellerOrders } from "./orders";
import { syncKeyPrices } from "./price-sync";
import { reconcilePendingGPayPurchases } from "./public-orders";

const TICK_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const JOB_LOCKS: Record<Exclude<BackgroundJobName, "scheduler">, number> = {
  "price-sync": 704_291_173,
  "order-sync": 704_291_174,
  "purchase-reconciliation": 704_291_175,
};

export const BACKGROUND_JOBS = [
  {
    name: "purchase-reconciliation",
    intervalSeconds: 60,
    run: reconcilePendingGPayPurchases,
  },
  { name: "order-sync", intervalSeconds: 5 * 60, run: syncDigisellerOrders },
  { name: "price-sync", intervalSeconds: 60 * 60, run: syncKeyPrices },
] as const;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown background job error";
}

function wasSkipped(result: unknown) {
  return (
    typeof result === "object" &&
    result !== null &&
    "skipped" in result &&
    result.skipped === true
  );
}

export async function ensureBackgroundWorkerSchema() {
  await db.execute(`
    create table if not exists sync_background_job_state (
      name text primary key,
      interval_seconds integer not null,
      last_heartbeat_at timestamptz,
      last_started_at timestamptz,
      last_successful_at timestamptz,
      last_finished_at timestamptz,
      consecutive_failures integer not null default 0,
      last_error text,
      last_result text,
      updated_at timestamptz not null default now()
    )
  `);
}

function lockIdFor(name: Exclude<BackgroundJobName, "scheduler">) {
  const schema = process.env.TEST_DATABASE_SCHEMA;
  if (!schema) return JOB_LOCKS[name];
  let hash = JOB_LOCKS[name];
  for (const character of schema) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return 1_500_000_000 + (hash >>> 0) % 500_000_000;
}

export async function recordWorkerHeartbeat(now = new Date()) {
  await db
    .insert(backgroundJobStateTable)
    .values({
      name: "scheduler",
      intervalSeconds: HEARTBEAT_MS / 1_000,
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: backgroundJobStateTable.name,
      set: {
        intervalSeconds: HEARTBEAT_MS / 1_000,
        lastHeartbeatAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
}

export async function runBackgroundJob<T>(
  name: Exclude<BackgroundJobName, "scheduler">,
  intervalSeconds: number,
  run: () => Promise<T>,
  options: { force?: boolean; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [lockIdFor(name)],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { status: "locked" as const };

    const [state] = await db
      .select()
      .from(backgroundJobStateTable)
      .where(eq(backgroundJobStateTable.name, name));
    if (
      !options.force &&
      state?.lastStartedAt &&
      now.getTime() - state.lastStartedAt.getTime() < intervalSeconds * 1_000 &&
      state.lastFinishedAt &&
      state.lastFinishedAt >= state.lastStartedAt
    ) {
      return { status: "not-due" as const };
    }

    await db
      .insert(backgroundJobStateTable)
      .values({
        name,
        intervalSeconds,
        lastHeartbeatAt: now,
        lastStartedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: backgroundJobStateTable.name,
        set: {
          intervalSeconds,
          lastHeartbeatAt: now,
          lastStartedAt: now,
          updatedAt: now,
        },
      });

    try {
      const result = await run();
      const finishedAt = new Date();
      const skipped = wasSkipped(result);
      await db
        .update(backgroundJobStateTable)
        .set({
          lastHeartbeatAt: finishedAt,
          ...(skipped ? {} : { lastSuccessfulAt: finishedAt }),
          lastFinishedAt: finishedAt,
          ...(skipped ? {} : { consecutiveFailures: 0, lastError: null }),
          lastResult: JSON.stringify(result),
          updatedAt: finishedAt,
        })
        .where(eq(backgroundJobStateTable.name, name));
      return {
        status: skipped ? ("skipped" as const) : ("completed" as const),
        result,
      };
    } catch (error) {
      const finishedAt = new Date();
      await db
        .update(backgroundJobStateTable)
        .set({
          lastHeartbeatAt: finishedAt,
          lastFinishedAt: finishedAt,
          consecutiveFailures:
            state?.consecutiveFailures === undefined
              ? 1
              : state.consecutiveFailures + 1,
          lastError: describeError(error),
          updatedAt: finishedAt,
        })
        .where(eq(backgroundJobStateTable.name, name));
      throw error;
    }
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock($1)", [lockIdFor(name)]);
    }
    client.release();
  }
}

export async function runWorkerTick(options: { force?: boolean } = {}) {
  await recordWorkerHeartbeat();
  return Promise.all(BACKGROUND_JOBS.map(async (job) => {
    try {
      return {
        name: job.name,
        ...(await runBackgroundJob(
          job.name,
          job.intervalSeconds,
          async () => job.run(),
          options,
        )),
      };
    } catch (error) {
      logger.error({ err: error, job: job.name }, "Background job failed");
      return { name: job.name, status: "failed" as const };
    }
  }));
}

export function startBackgroundWorker(options: {
  tickMs?: number;
  heartbeatMs?: number;
  runTick?: () => Promise<unknown>;
} = {}) {
  const tickMs = options.tickMs ?? TICK_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const runSafely = async () => {
    try {
      await (options.runTick?.() ?? runWorkerTick());
    } catch (error) {
      logger.error({ err: error }, "Background worker tick failed");
    }
  };
  const heartbeat = async () => {
    try {
      await recordWorkerHeartbeat();
    } catch (error) {
      logger.error({ err: error }, "Background worker heartbeat failed");
    }
  };
  const tickTimer = setInterval(() => void runSafely(), tickMs);
  const heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
  void runSafely();
  logger.info("Durable background worker started");
  return () => {
    clearInterval(tickTimer);
    clearInterval(heartbeatTimer);
  };
}

export async function listBackgroundJobHealth(now = new Date()) {
  const states = await db.select().from(backgroundJobStateTable);
  const byName = new Map(states.map((state) => [state.name, state]));
  return (["scheduler", ...BACKGROUND_JOBS.map((job) => job.name)] as BackgroundJobName[]).map(
    (name) => {
      const state = byName.get(name);
      const intervalSeconds =
        name === "scheduler"
          ? HEARTBEAT_MS / 1_000
          : BACKGROUND_JOBS.find((job) => job.name === name)!.intervalSeconds;
      const freshnessBase =
        name === "scheduler" ? state?.lastHeartbeatAt : state?.lastSuccessfulAt;
      const staleAfterSeconds =
        name === "scheduler" ? intervalSeconds * 3 : intervalSeconds * 2 + 60;
      return {
        name,
        intervalSeconds,
        lastHeartbeatAt: state?.lastHeartbeatAt ?? null,
        lastStartedAt: state?.lastStartedAt ?? null,
        lastSuccessfulAt: state?.lastSuccessfulAt ?? null,
        lastFinishedAt: state?.lastFinishedAt ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastError: state?.lastError ?? null,
        isRunning: Boolean(
          state?.lastStartedAt &&
            (!state.lastFinishedAt || state.lastFinishedAt < state.lastStartedAt),
        ),
        isStale:
          !freshnessBase ||
          now.getTime() - freshnessBase.getTime() > staleAfterSeconds * 1_000,
      };
    },
  );
}