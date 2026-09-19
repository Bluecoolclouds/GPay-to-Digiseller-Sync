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
    "First infer what the named product actually is from the title: a video game, DLC or expansion, subscription or game time, in-game currency or item, software, or another kind of digital product.",
    "Build the visual concept around that inferred product category. If it is a video game, reflect its recognizable genre, setting, mood, era, and gameplay themes. If it is not a game, depict the correct service or digital-product concept instead of inventing game artwork.",
    "Use an original visual interpretation with bold geometric shapes, subtle depth, controlled cinematic lighting, a clean composition, and a dark modern background with one vivid accent color.",
    `Include only this exact short typography: "${title}" as the main title, plus "${typeLabel}" and "${region}" as small secondary keywords.`,
    "Keep all text large, crisp, correctly spelled, and inside the central safe area.",
    "No logos, no storefront UI, no price, no buttons, no borders, no screenshots, no characters copied from existing game artwork, no watermarks, and no extra words.",
    "The result must be a clean finished product image, not a mockup photographed in a scene.",
  ].join(" ");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/images/generations`, {
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
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new Error(
      `Запрос генерации не выполнен: ${
        error instanceof Error ? error.message : "ошибка сети"
      }`,
      { cause: error },
    );
  }
  let json: ImageGenerationResponse;
  try {
    json = (await response.json()) as ImageGenerationResponse;
  } catch (error) {
    throw new Error(
      `API генерации вернул некорректный ответ (${response.status})`,
      { cause: error },
    );
  }
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