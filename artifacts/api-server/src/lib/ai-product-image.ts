const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
};

function getShortProductTitle(name: string) {
  return name
    .split("|")[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
}

export async function generateAiProductImage(input: {
  name: string;
  productKind: "key" | "gift";
  region: string;
}): Promise<Buffer> {
  const apiKey = process.env.APINET_API_KEY;
  const baseUrl = (process.env.APINET_BASE_URL || "https://apinet.cloud").replace(
    /\/+$/,
    "",
  );
  if (!apiKey) {
    throw new Error("APINET_API_KEY is not configured");
  }

  const title = getShortProductTitle(input.name);
  const typeLabel = input.productKind === "key" ? "DIGITAL KEY" : "STEAM GIFT";
  const region = (input.region || "GLOBAL").slice(0, 30);
  const prompt = [
    "Create a square 1:1 minimalist premium product card for a digital game marketplace.",
    `Product: "${title}". Type: "${typeLabel}". Region: "${region}".`,
    "Use an original abstract visual inspired only by the product name: bold geometric shapes, subtle depth, controlled cinematic lighting, clean composition, dark modern background with one vivid accent color.",
    `Include only this exact short typography: "${title}" as the main title, plus "${typeLabel}" and "${region}" as small secondary keywords.`,
    "Keep all text large, crisp, correctly spelled, and inside the central safe area.",
    "No logos, no storefront UI, no price, no buttons, no borders, no screenshots, no characters copied from existing game artwork, no watermarks, and no extra words.",
    "The result must be a clean finished product image, not a mockup photographed in a scene.",
  ].join(" ");

  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await response.json()) as ImageGenerationResponse;
  const image = json.data?.[0];
  if (!response.ok || !image) {
    throw new Error(
      json.error?.message || `AI image API returned ${response.status}`,
    );
  }

  let bytes: Buffer;
  if (image.b64_json) {
    bytes = Buffer.from(image.b64_json, "base64");
  } else if (image.url) {
    const imageResponse = await fetch(image.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!imageResponse.ok) {
      throw new Error(`AI image download returned ${imageResponse.status}`);
    }
    bytes = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new Error("AI image API returned no image data");
  }

  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("AI image has an invalid size");
  }
  return bytes;
}