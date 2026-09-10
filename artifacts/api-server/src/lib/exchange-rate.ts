type RateSnapshot = {
  usdRub: number;
  source: string;
  effectiveDate: string;
  fetchedAt: string;
  isFallback: boolean;
};

let cache: { expiresAt: number; value: RateSnapshot } | null = null;

export async function getOfficialUsdRubRate(fallback: number): Promise<RateSnapshot> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  try {
    const response = await fetch("https://www.cbr.ru/scripts/XML_daily.asp", {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/xml,text/xml" },
    });
    if (!response.ok) throw new Error(`CBR returned ${response.status}`);
    const xml = await response.text();
    const date = xml.match(/<ValCurs Date="([^"]+)"/)?.[1];
    const usdBlock = [...xml.matchAll(/<Valute[^>]*>[\s\S]*?<\/Valute>/g)]
      .map((match) => match[0])
      .find((block) => block.includes("<CharCode>USD</CharCode>"));
    const nominal = Number(usdBlock?.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1] ?? 1);
    const value = Number((usdBlock?.match(/<Value>([^<]+)<\/Value>/)?.[1] ?? "").replace(",", "."));
    const usdRub = value / nominal;
    if (!date || !Number.isFinite(usdRub) || usdRub <= 0) throw new Error("USD rate missing in CBR response");

    const snapshot = {
      usdRub,
      source: "ЦБ РФ",
      effectiveDate: date,
      fetchedAt: new Date().toISOString(),
      isFallback: false,
    };
    cache = { expiresAt: Date.now() + 60 * 60 * 1000, value: snapshot };
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