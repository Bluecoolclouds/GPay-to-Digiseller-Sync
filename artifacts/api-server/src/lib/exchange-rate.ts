type RateSnapshot = {
  usdRub: number;
  conversionMarkupPercent?: number;
  purchaseRate?: number;
  source: string;
  effectiveDate: string;
  fetchedAt: string;
  isFallback: boolean;
};

let cache: { expiresAt: number; value: RateSnapshot } | null = null;

type BestChangeRate = {
  rate?: string | number;
  reserve?: string | number;
};

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function getOfficialUsdRubRate(fallback: number): Promise<RateSnapshot> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  try {
    const apiKey = process.env.BESTCHANGE_API_KEY;
    if (!apiKey) throw new Error("BESTCHANGE_API_KEY is not configured");
    const response = await fetch(
      `https://bestchange.app/v2/${encodeURIComponent(apiKey)}/rates/21-10+42-10`,
      {
      signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json", "accept-encoding": "gzip" },
      },
    );
    if (!response.ok) throw new Error(`BestChange returned ${response.status}`);
    const json = (await response.json()) as {
      rates?: Record<string, BestChangeRate[]>;
    };
    const candidates = ["21-10", "42-10"].flatMap((pair) =>
      (json.rates?.[pair] ?? [])
        .slice(0, 10)
        .filter((offer) => Number(offer.reserve) >= 1_000)
        .map((offer) => Number(offer.rate))
        .filter((rate) => Number.isFinite(rate) && rate > 0),
    );
    if (candidates.length < 3) {
      throw new Error("BestChange returned too few usable rates");
    }
    const usdRub = median(candidates);
    const now = new Date();

    const snapshot = {
      usdRub,
      source: "BestChange: СБП/Сбер → USDT TRC20",
      effectiveDate: now.toLocaleDateString("ru-RU"),
      fetchedAt: now.toISOString(),
      isFallback: false,
    };
    cache = { expiresAt: Date.now() + 10 * 60 * 1000, value: snapshot };
    return snapshot;
  } catch {
    return {
      usdRub: fallback,
      source: "Настройки приложения",
      effectiveDate: new Date().toLocaleDateString("ru-RU"),
      fetchedAt: new Date().toISOString(),
      isFallback: true,
    };
  }
}