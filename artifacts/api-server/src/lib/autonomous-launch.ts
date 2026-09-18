import { and, eq, inArray } from "drizzle-orm";
import { db, productsTable, settingsTable } from "@workspace/db";
import { classifyGPayProductType, loginGPay } from "./gpay";
import { loginDigiseller } from "./digiseller";
import { getOfficialUsdRubRate } from "./exchange-rate";
import { listBackgroundJobHealth } from "./background-worker";

export const AUTONOMOUS_ALLOWLIST_MIN = 5;
export const AUTONOMOUS_ALLOWLIST_MAX = 10;
export const AUTONOMOUS_PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1_000;

export function parseAutonomousAllowlist(value: string | null | undefined) {
  if (!value) return [] as number[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is number => Number.isInteger(id) && id > 0))]
      : [];
  } catch {
    return [];
  }
}

export async function getAutonomousAllowlist() {
  const [settings] = await db.select({ value: settingsTable.autonomousAllowlist })
    .from(settingsTable).where(eq(settingsTable.id, 1));
  return parseAutonomousAllowlist(settings?.value);
}

export async function isAutonomousProductAllowed(productId: number) {
  const allowlist = await getAutonomousAllowlist();
  return allowlist.includes(productId);
}

export async function runAutonomousPreflight() {
  await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  const products = await db.select({ id: productsTable.id, productType: productsTable.productType,
    publicationStatus: productsTable.publicationStatus, isAvailable: productsTable.isAvailable })
    .from(productsTable);
  const allowlist = parseAutonomousAllowlist(settings?.autonomousAllowlist);
  const eligible = products.filter((p) => allowlist.includes(p.id) &&
    classifyGPayProductType(p.productType) === "key" &&
    p.publicationStatus === "published" && p.isAvailable);
  const checkedAt = new Date();
  const workers = await listBackgroundJobHealth();
  const workerHealthy =
    workers.length >= 4 &&
    workers.every((worker) => {
      if (worker.consecutiveFailures !== 0) return false;
      if (worker.name !== "price-sync" || settings?.automationMode !== "manual") {
        return !worker.isStale;
      }
      if (!worker.lastFinishedAt) return false;
      const manualFreshnessMs = (worker.intervalSeconds * 2 + 60) * 1_000;
      return (
        checkedAt.getTime() - new Date(worker.lastFinishedAt).getTime() <=
        manualFreshnessMs
      );
    });
  let gpayHealthy = false;
  let digisellerHealthy = false;
  let rateFresh = false;
  try { await loginGPay(); gpayHealthy = true; } catch { /* status is returned below */ }
  try { await loginDigiseller(); digisellerHealthy = true; } catch { /* status is returned below */ }
  try {
    const rate = settings?.exchangeRateMode === "manual"
      ? { isFallback: !(settings.usdRubRate > 0) }
      : await getOfficialUsdRubRate(settings?.usdRubRate ?? 92);
    rateFresh = !rate.isFallback;
  } catch { /* status is returned below */ }
  const checks = {
    gpay: gpayHealthy,
    digiseller: digisellerHealthy,
    rate: rateFresh,
    workers: workerHealthy,
    allowlist: eligible.length >= AUTONOMOUS_ALLOWLIST_MIN &&
      eligible.length <= AUTONOMOUS_ALLOWLIST_MAX,
  };
  const passed = Object.values(checks).every(Boolean);
  await db.update(settingsTable).set({
    launchPreflightAt: passed ? checkedAt : null,
    updatedAt: checkedAt,
  }).where(eq(settingsTable.id, 1));
  return { passed, checks, allowlistedProductCount: eligible.length, checkedAt };
}

export async function assertAutonomousProductAllowed(productId: number) {
  const [product] = await db.select({ id: productsTable.id, productType: productsTable.productType })
    .from(productsTable).where(and(eq(productsTable.id, productId), inArray(productsTable.productType, ["2"])));
  if (!product || !(await isAutonomousProductAllowed(productId))) {
    throw new Error("Товар не входит в разрешённый автономный набор");
  }
}