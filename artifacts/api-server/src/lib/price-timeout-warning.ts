export const PRICE_TASK_TIMEOUT_TEXT =
  "Digiseller не завершил обновление цен";

const TIMEOUT_SUMMARY_PATTERN =
  /Тайм-аут задачи Digiseller: затронуто (\d+)\. Последняя ошибка: (.+)$/;

export type PriceTimeoutRun = {
  affectedProductCount: number;
  latestError: string;
};

export function createPriceTimeoutSummary(errors: string[]): string | null {
  const timeoutErrors = errors.filter((error) =>
    error.includes(PRICE_TASK_TIMEOUT_TEXT),
  );
  if (timeoutErrors.length === 0) return null;

  return `Тайм-аут задачи Digiseller: затронуто ${timeoutErrors.length}. Последняя ошибка: ${timeoutErrors.at(-1)}`;
}

export function parsePriceTimeoutRun(description: string): PriceTimeoutRun | null {
  const match = description.match(TIMEOUT_SUMMARY_PATTERN);
  if (!match) return null;

  return {
    affectedProductCount: Number(match[1]),
    latestError: match[2],
  };
}

export function getRepeatedPriceTimeoutWarning(
  latestPriceActivities: Array<{ description: string }>,
): PriceTimeoutRun | null {
  if (latestPriceActivities.length < 2) return null;
  const latest = parsePriceTimeoutRun(latestPriceActivities[0].description);
  const previous = parsePriceTimeoutRun(latestPriceActivities[1].description);
  return latest && previous ? latest : null;
}