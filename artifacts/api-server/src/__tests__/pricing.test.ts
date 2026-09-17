import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateProductPrice } from "../lib/pricing";

const baseRules = {
  usdRubRate: 100,
  conversionMarkupPercent: 0,
  digisellerFeePercent: 5,
  fixedReserveRub: 30,
  minimumProfitRub: 100,
};

for (const scenario of [
  { name: "minimum profit controls a low-margin price", usd: 10, margin: 0 },
  { name: "margin and reserve control a high-margin price", usd: 10, margin: 20 },
  { name: "zero supplier price still preserves the reserve", usd: 0, margin: 15 },
  { name: "zero fee remains valid", usd: 10, margin: 15, fee: 0 },
  { name: "large fee is grossed up rather than added", usd: 10, margin: 15, fee: 40 },
]) {
  test(scenario.name, () => {
    const rules = {
      ...baseRules,
      digisellerFeePercent: scenario.fee ?? baseRules.digisellerFeePercent,
    };
    const result = calculateProductPrice(scenario.usd, rules, scenario.margin);
    const feeMultiplier = 1 - rules.digisellerFeePercent / 100;
    const netRevenue = result.salePriceRub * feeMultiplier;
    const requiredNet = Math.max(
      result.baseRub * (1 + scenario.margin / 100) + rules.fixedReserveRub,
      result.baseRub + rules.minimumProfitRub,
    );

    assert.ok(netRevenue >= requiredNet);
    assert.ok(result.profitRub + 1e-9 >= rules.minimumProfitRub);
    assert.equal(result.profitRub, netRevenue - result.baseRub);
    if (result.salePriceRub > 0) {
      assert.ok((result.salePriceRub - 1) * feeMultiplier < requiredNet);
    }
  });
}

test("a 100 percent Digiseller fee is rejected", () => {
  assert.throws(
    () =>
      calculateProductPrice(
        10,
        { ...baseRules, digisellerFeePercent: 100 },
        15,
      ),
    /between 0 and 100/,
  );
});