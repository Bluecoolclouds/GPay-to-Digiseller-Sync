import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { updateDigisellerProductPrices } from "../lib/digiseller";

const originalFetch = globalThis.fetch;
const taskId = "12345678-1234-1234-1234-123456789abc";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockPriceTask(
  taskResponse: string | Record<string, unknown>,
  statuses: Array<Record<string, unknown>>,
) {
  const requestedStatuses: number[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/product/edit/prices")) {
      return typeof taskResponse === "string"
        ? new Response(taskResponse)
        : Response.json(taskResponse);
    }
    if (url.includes("/UpdateProductsTaskStatus")) {
      const status = statuses[requestedStatuses.length];
      assert.ok(status, "Unexpected extra status poll");
      requestedStatuses.push(Number(status.Status));
      return Response.json(status);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return requestedStatuses;
}

const immediatePolling = {
  pollIntervalMs: 0,
  sleep: async () => {},
};

test("accepts a JSON task ID and completes after queued and in-progress statuses", async () => {
  const requestedStatuses = mockPriceTask(
    { taskId },
    [{ Status: 0 }, { Status: 1 }, { Status: 3, ErrorCount: 0 }],
  );

  const failures = await updateDigisellerProductPrices(
    [{ productId: 101, priceRub: 1500 }],
    "token",
    immediatePolling,
  );

  assert.deepEqual(requestedStatuses, [0, 1, 3]);
  assert.equal(failures.size, 0);
});

test("accepts the live plain-text UUID task ID response", async () => {
  mockPriceTask(taskId, [{ Status: 3, ErrorCount: 0 }]);

  const failures = await updateDigisellerProductPrices(
    [{ productId: 102, priceRub: 1600 }],
    "token",
    immediatePolling,
  );

  assert.equal(failures.size, 0);
});

test("returns per-product failures from terminal error status", async () => {
  mockPriceTask(
    { TaskId: taskId },
    [
      {
        Status: 2,
        ErrorCount: 1,
        ErrorsDescriptions: [{ Key: "103", Value: "invalid price" }],
      },
    ],
  );

  const failures = await updateDigisellerProductPrices(
    [{ productId: 103, priceRub: 1700 }],
    "token",
    immediatePolling,
  );

  assert.deepEqual([...failures], [[103, "invalid price"]]);
});

test("rejects a terminal error without product details", async () => {
  mockPriceTask(taskId, [{ Status: 2, ErrorCount: 0 }]);

  await assert.rejects(
    updateDigisellerProductPrices(
      [{ productId: 104, priceRub: 1800 }],
      "token",
      immediatePolling,
    ),
    /завершил задачу обновления цен с ошибкой/,
  );
});

test("times out while the task remains queued", async () => {
  let currentTime = 0;
  mockPriceTask(taskId, [{ Status: 0 }, { Status: 0 }]);

  await assert.rejects(
    updateDigisellerProductPrices(
      [{ productId: 105, priceRub: 1900 }],
      "token",
      {
        pollIntervalMs: 1,
        timeoutMs: 2,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      },
    ),
    /не завершил обновление цен/,
  );
});