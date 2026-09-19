import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { uploadDigisellerProductImage } from "../lib/digiseller";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.APINET_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.APINET_API_KEY;
  } else {
    process.env.APINET_API_KEY = originalApiKey;
  }
});

test("AI image failure is exposed and never uploads a local fallback", async () => {
  process.env.APINET_API_KEY = "test-api-key";
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://images.test/product.png") {
      return new Response("missing", { status: 404 });
    }
    if (url.endsWith("/v1/images/generations")) {
      return Response.json(
        { error: { message: "generation quota exceeded" } },
        { status: 429 },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    uploadDigisellerProductImage(
      123,
      {
        imageUrl: "https://images.test/product.png",
        name: "Test Game",
        productKind: "key",
        region: "GLOBAL",
      },
      "digiseller-token",
    ),
    /Изображение GPay: Не удалось скачать изображение GPay \(404\).*gpt-image-2: generation quota exceeded/,
  );
  assert.equal(
    requestedUrls.some((url) => url.includes("/api/product/preview/add/images/")),
    false,
  );
});

test("forced regeneration makes the new image primary and removes old previews", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === "https://images.test/product.png") {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    }
    if (url.includes("/api/product/preview/add/images/123")) {
      return Response.json({
        retval: 0,
        content: [{ preview_id: 99 }],
      });
    }
    if (url.includes("/api/products/123/data")) {
      return Response.json({
        retval: 0,
        preview_imgs: [{ id: 11 }, { id: 99 }],
      });
    }
    if (url.includes("/api/product/preview/options/image/")) {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await uploadDigisellerProductImage(
    123,
    {
      imageUrl: "https://images.test/product.png",
      name: "Test Game",
      productKind: "key",
      region: "GLOBAL",
      replaceExisting: true,
    },
    "digiseller-token",
  );

  assert.deepEqual(
    calls
      .filter((call) => call.url.includes("/api/product/preview/options/image/"))
      .map((call) => ({
        previewId: Number(call.url.match(/image\/(\d+)/)?.[1]),
        body: call.body,
      })),
    [
      {
        previewId: 99,
        body: { enabled: true, index: 0, delete: false },
      },
      { previewId: 11, body: { delete: true } },
    ],
  );
});