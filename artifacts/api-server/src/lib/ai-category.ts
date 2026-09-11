type CategoryCandidate = {
  id: number;
  name: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export async function selectCategoryWithAi(
  productName: string,
  candidates: CategoryCandidate[],
): Promise<number | null> {
  const apiKey = process.env.APINET_API_KEY;
  if (!apiKey || candidates.length === 0) return null;

  const baseUrl = (process.env.APINET_BASE_URL || "https://apinet.cloud").replace(
    /\/+$/,
    "",
  );
  const allowedIds = new Set(candidates.map((candidate) => candidate.id));
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You map marketplace product names to an existing category. Choose only an ID from the supplied candidates. Your entire response must be one JSON object with exactly these fields: {\"categoryId\":number|null,\"confidence\":\"high\"|\"low\",\"reason\":string}. Use null unless the product identity clearly matches a candidate. Never invent an ID. Do not browse, recommend products, discuss prices, or add markdown.",
        },
        {
          role: "user",
          content: JSON.stringify({ productName, candidates }),
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(
      json.error?.message || `AI category API returned ${response.status}`,
    );
  }

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) return null;
  const jsonText = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const selection = JSON.parse(jsonText) as {
    categoryId?: number | null;
    confidence?: string;
    candidates?: Array<{ id?: number; match?: boolean }>;
  };
  if (
    selection.confidence === "high" &&
    typeof selection.categoryId === "number" &&
    allowedIds.has(selection.categoryId)
  ) {
    return selection.categoryId;
  }

  const explicitMatches = (selection.candidates ?? []).filter(
    (candidate) =>
      candidate.match === true &&
      typeof candidate.id === "number" &&
      allowedIds.has(candidate.id),
  );
  return explicitMatches.length === 1 ? explicitMatches[0].id! : null;
}