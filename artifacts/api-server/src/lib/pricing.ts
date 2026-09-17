export type PricingRules = {
  usdRubRate: number;
  conversionMarkupPercent: number;
  digisellerFeePercent: number;
  fixedReserveRub: number;
  minimumProfitRub: number;
};

export type CalculatedPrice = {
  baseRub: number;
  salePriceRub: number;
  profitRub: number;
};

export function calculateProductPrice(
  supplierPriceUsd: number,
  settings: PricingRules,
  marginPercent: number,
): CalculatedPrice {
  if (!Number.isFinite(supplierPriceUsd) || supplierPriceUsd < 0) {
    throw new Error("Supplier price must be a non-negative number");
  }
  const feeRate = settings.digisellerFeePercent / 100;
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error("Digiseller fee must be between 0 and 100 percent");
  }
  const purchaseRate =
    settings.usdRubRate * (1 + settings.conversionMarkupPercent / 100);
  const baseRub = supplierPriceUsd * purchaseRate;
  const requiredNetRub = Math.max(
    baseRub * (1 + marginPercent / 100) + settings.fixedReserveRub,
    baseRub + settings.minimumProfitRub,
  );
  const salePriceRub = Math.ceil(requiredNetRub / (1 - feeRate));
  const profitRub = salePriceRub * (1 - feeRate) - baseRub;
  return { baseRub, salePriceRub, profitRub };
}