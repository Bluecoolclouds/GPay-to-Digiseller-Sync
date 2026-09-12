import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateAiProductImage } from "./ai-product-image";
import { selectCategoryWithAi } from "./ai-category";
import { logger } from "./logger";

type DigiLoginResponse = {
  token?: string;
  retval?: number;
  desc?: string;
};

type CreateProductResult = {
  retval?: number;
  retdesc?: string;
  errors?: Array<{ message?: string; description?: string }>;
  content?: { product_id?: number };
};

type AddImageResult = {
  retval?: number;
  retdesc?: string;
  errors?: Array<{ message?: string; description?: string }>;
  content?: Array<{ preview_id?: number; url?: string }>;
};

type PriceUpdateTaskResult = {
  taskId?: string;
  TaskId?: string;
  retval?: number;
  retdesc?: string;
  errors?: Array<{ message?: string; description?: string }>;
};

type PriceUpdateTaskStatus = {
  TaskId?: string;
  Status?: number;
  SuccessCount?: number;
  ErrorCount?: number;
  TotalCount?: number;
  ErrorsDescriptions?: Array<{ Key?: string; Value?: string }>;
};

type PriceUpdatePollingOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type DigisellerErrorResult = {
  retval?: number;
  retdesc?: string;
  errors?: Array<{ message?: string; description?: string }>;
};

type ProductInput = {
  name: string;
  descriptionRu: string;
  descriptionEn: string;
  priceRub: number;
  productType: string;
};

const cataloguerCategoryCache = new Map<string, number>();

function getDigisellerError(json: DigisellerErrorResult, fallback: string) {
  const details = json.errors
    ?.map((error) => {
      if (typeof error === "string") return error;
      if (typeof error.message === "string") return error.message;
      if (typeof error.description === "string") return error.description;
      return JSON.stringify(error);
    })
    .filter(Boolean)
    .join("; ");
  const description =
    typeof json.retdesc === "string"
      ? json.retdesc
      : json.retdesc
        ? JSON.stringify(json.retdesc)
        : "";
  return details || description || fallback;
}

export async function loginDigiseller(): Promise<string> {
  const sellerId = Number(process.env.DIGISELLER_SELLER_ID);
  const login = process.env.DIGISELLER_LOGIN;
  const apiGuid = process.env.DIGISELLER_API_GUID;
  if (!sellerId || !login || !apiGuid) {
    throw new Error("Digiseller credentials are not configured");
  }

  const timestamp = Date.now();
  const sign = createHash("sha256").update(`${apiGuid}${timestamp}`).digest("hex");
  const response = await fetch("https://api.digiseller.com/api/apilogin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      seller_id: sellerId,
      id_seller: sellerId,
      login,
      timestamp,
      sign,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json()) as DigiLoginResponse;
  if (!response.ok || !json.token) {
    throw new Error(json.desc || `Digiseller API returned ${response.status}`);
  }
  return json.token;
}

export type DigisellerSale = {
  date: string;
  invoiceId: string;
  productId: number;
  productName: string;
  paidAmountRub?: number | null;
  amountIn?: number | null;
  amountCurrency?: string | null;
  isReturned: boolean;
};

export function parseDigisellerDate(value: string) {
  const trimmed = value.trim();
  let normalized = trimmed;
  const russianDate = trimmed.match(
    /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (russianDate) {
    normalized = `${russianDate[3]}-${russianDate[2]}-${russianDate[1]}T${russianDate[4]}:${russianDate[5]}:${russianDate[6] ?? "00"}+03:00`;
  } else if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)
  ) {
    normalized = `${trimmed.replace(" ", "T")}+03:00`;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A page from seller-sells/v2.  This endpoint deliberately returns pages
 * rather than silently truncating the seller's sales at 1,000 rows.
 */
export type DigisellerSalesPage = {
  page: number;
  pages: number;
  totalRows: number;
  rawRowCount: number;
  sales: DigisellerSale[];
};

const DIGISELLER_SALES_PAGE_SIZE = 1_000;

export async function fetchDigisellerSalesPage(input: {
  productIds: number[];
  dateStart: string;
  dateFinish: string;
  page: number;
  providedToken?: string;
}): Promise<DigisellerSalesPage> {
  if (input.productIds.length === 0) {
    return {
      page: input.page,
      pages: 0,
      totalRows: 0,
      rawRowCount: 0,
      sales: [],
    };
  }
  const token = input.providedToken ?? (await loginDigiseller());
  const url = new URL("https://api.digiseller.com/api/seller-sells/v2");
  url.searchParams.set("token", token);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      product_ids: input.productIds,
      date_start: input.dateStart,
      date_finish: input.dateFinish,
      returned: 0,
      page: input.page,
      rows: DIGISELLER_SALES_PAGE_SIZE,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    retval?: number;
    retdesc?: string;
    total_rows?: number;
    pages?: number;
    page?: number;
    rows?: Array<{
      invoice_id?: string | number;
      product_id?: string | number;
      product_name?: string;
      date_pay?: string;
      amount_in?: string | number | null;
      amount_currency?: string | null;
      returned?: boolean | number | string | null;
    }>;
  };
  if (!response.ok || body.retval !== 0) {
    throw new Error(
      body.retdesc || `Digiseller sales API returned ${response.status}`,
    );
  }
  if (
    typeof body.page !== "number" ||
    !Number.isInteger(body.page) ||
    typeof body.pages !== "number" ||
    !Number.isInteger(body.pages) ||
    typeof body.total_rows !== "number" ||
    !Number.isInteger(body.total_rows) ||
    body.page < 1 ||
    body.pages < 0 ||
    body.total_rows < 0 ||
    !Array.isArray(body.rows)
  ) {
    throw new Error("Digiseller sales API returned malformed pagination");
  }
  const page = body.page;
  const pages = body.pages;
  const totalRows = body.total_rows;
  const rows = body.rows;
  const expectedPages =
    totalRows === 0 ? 0 : Math.ceil(totalRows / DIGISELLER_SALES_PAGE_SIZE);
  if (pages !== expectedPages || (pages === 0 && rows.length > 0)) {
    throw new Error("Digiseller sales API returned inconsistent pagination");
  }
  const sales = rows.map((sale, index) => {
    const productId = Number(sale.product_id);
    const invoiceId =
      sale.invoice_id === undefined ? "" : String(sale.invoice_id);
    const date = typeof sale.date_pay === "string" ? sale.date_pay : "";
    const productName =
      typeof sale.product_name === "string" ? sale.product_name.trim() : "";
    if (
      !invoiceId.trim() ||
      !date ||
      !productName ||
      !Number.isInteger(productId) ||
      productId <= 0 ||
      !parseDigisellerDate(date)
    ) {
      throw new Error(
        `Digiseller sales API returned malformed row ${index + 1}`,
      );
    }
    const rawAmountValue =
      sale.amount_in === null || sale.amount_in === undefined
        ? null
        : Number(sale.amount_in);
    if (
      (typeof sale.amount_in === "string" &&
        sale.amount_in.trim().length === 0) ||
      (rawAmountValue !== null && !Number.isFinite(rawAmountValue))
    ) {
      throw new Error(
        `Digiseller sales API returned malformed amount in row ${index + 1}`,
      );
    }
    if (
      sale.returned === undefined ||
      sale.returned === null ||
      (
      sale.returned !== false &&
      sale.returned !== 0 &&
      sale.returned !== "0" &&
      sale.returned !== true &&
      sale.returned !== 1 &&
      sale.returned !== "1"
      )
    ) {
      throw new Error(
        `Digiseller sales API returned malformed return state in row ${index + 1}`,
      );
    }
    const isReturned =
      sale.returned === true ||
      sale.returned === 1 ||
      sale.returned === "1";
    return {
      invoiceId: invoiceId.trim(),
      date,
      productId,
      productName,
      amountIn: rawAmountValue,
      amountCurrency: sale.amount_currency ?? null,
      isReturned,
    };
  });
  return {
    page,
    pages,
    totalRows,
    rawRowCount: rows.length,
    sales,
  };
}

export async function updateDigisellerProductPrices(
  prices: Array<{ productId: number; priceRub: number }>,
  providedToken?: string,
  polling: PriceUpdatePollingOptions = {},
): Promise<Map<number, string>> {
  const failures = new Map<number, string>();
  if (prices.length === 0) return failures;

  const token = providedToken ?? (await loginDigiseller());
  const response = await fetch(
    `https://api.digiseller.com/api/product/edit/prices?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        prices.map(({ productId, priceRub }) => ({
          product_id: productId,
          price: Math.ceil(priceRub),
        })),
      ),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const taskBody = await response.text();
  let task: PriceUpdateTaskResult = {};
  let taskId: string | undefined;
  try {
    task = JSON.parse(taskBody) as PriceUpdateTaskResult;
    taskId = task.taskId ?? task.TaskId;
  } catch {
    const plainTaskId = taskBody.trim().replace(/^"|"$/g, "");
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(plainTaskId)) {
      taskId = plainTaskId;
    }
  }
  if (!response.ok || !taskId) {
    throw new Error(
      getDigisellerError(
        task,
        taskBody || `Не удалось запустить обновление цен (${response.status})`,
      ),
    );
  }

  const now = polling.now ?? Date.now;
  const sleep =
    polling.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = polling.timeoutMs ?? 60_000;
  const pollIntervalMs = polling.pollIntervalMs ?? 1_000;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    const statusUrl = new URL(
      "https://api.digiseller.com/api/product/edit/UpdateProductsTaskStatus",
    );
    statusUrl.searchParams.set("taskId", taskId);
    statusUrl.searchParams.set("token", token);
    const statusResponse = await fetch(statusUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const status = (await statusResponse.json()) as PriceUpdateTaskStatus;
    if (!statusResponse.ok) {
      throw new Error(`Не удалось проверить обновление цен (${statusResponse.status})`);
    }
    if (status.Status === 0 || status.Status === 1) continue;

    for (const error of status.ErrorsDescriptions ?? []) {
      const productId = Number(error.Key);
      if (Number.isInteger(productId)) {
        failures.set(productId, error.Value || "Digiseller не обновил цену");
      }
    }
    if ((status.ErrorCount ?? failures.size) > failures.size) {
      throw new Error(
        `Digiseller сообщил об ошибках обновления цен: ${status.ErrorCount}`,
      );
    }
    if (status.Status === 2 && failures.size === 0) {
      throw new Error("Digiseller завершил задачу обновления цен с ошибкой");
    }
    if (status.Status !== 3 && status.Status !== 2) {
      throw new Error(`Неизвестный статус обновления цен: ${status.Status}`);
    }
    return failures;
  }

  throw new Error(
    `Digiseller не завершил обновление цен за ${Math.ceil(timeoutMs / 1_000)} секунд`,
  );
}

export async function createDigisellerProduct(input: {
  name: string;
  descriptionRu: string;
  descriptionEn: string;
  priceRub: number;
  productType: string;
}, providedToken?: string, platiCategoryId?: number | null): Promise<number> {
  const token = providedToken ?? (await loginDigiseller());
  const categories = await resolveProductCategories(input, token, platiCategoryId);
  const payload = buildProductPayload(input, categories);
  const productKind = input.productType === "2" ? "uniquefixed" : "arbitrary";
  const response = await fetch(
    `https://api.digiseller.com/api/product/create/${productKind}?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as CreateProductResult;
  const productId = json.content?.product_id;
  if (!response.ok || json.retval !== 0 || !productId) {
    throw new Error(getDigisellerError(json, `Digiseller API returned ${response.status}`));
  }
  return productId;
}

export async function setDigisellerCodeUnlimitedStock(
  productId: number,
  providedToken?: string,
): Promise<void> {
  const token = providedToken ?? (await loginDigiseller());
  const url = new URL(
    "https://api.digiseller.com/api/product/content/code/count",
  );
  url.searchParams.set("product_id", String(productId));
  url.searchParams.set("variant_id", "0");
  url.searchParams.set("token", token);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ count: -1 }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json()) as DigisellerErrorResult & {
    content?: { count?: number | string };
  };
  if (
    !response.ok ||
    json.retval !== 0 ||
    Number(json.content?.count) !== -1
  ) {
    throw new Error(
      getDigisellerError(
        json,
        `Не удалось установить безлимитный остаток Code (${response.status})`,
      ),
    );
  }
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export async function uploadDigisellerProductImage(
  productId: number,
  input: {
    imageUrl: string | null;
    name: string;
    productKind: "key" | "gift";
    region: string;
  },
  providedToken?: string,
): Promise<void> {
  let bytes: ArrayBuffer | Buffer | null = null;
  let contentType = "image/png";
  let extension = "png";

  if (input.imageUrl) {
    try {
      const parsedUrl = new URL(input.imageUrl);
      if (parsedUrl.protocol !== "https:") {
        throw new Error("Изображение GPay должно использовать HTTPS");
      }
      const imageResponse = await fetch(parsedUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!imageResponse.ok) {
        throw new Error(`Не удалось скачать изображение GPay (${imageResponse.status})`);
      }
      const responseType = imageResponse.headers
        .get("content-type")
        ?.split(";")[0]
        .trim();
      if (!responseType || !ALLOWED_IMAGE_TYPES.has(responseType)) {
        throw new Error(`Неподдерживаемый формат изображения: ${responseType || "не указан"}`);
      }
      const declaredSize = Number(imageResponse.headers.get("content-length") || 0);
      if (declaredSize > MAX_IMAGE_BYTES) {
        throw new Error("Изображение GPay превышает 10 МБ");
      }
      const downloaded = await imageResponse.arrayBuffer();
      if (downloaded.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("Изображение GPay превышает 10 МБ");
      }
      bytes = downloaded;
      contentType = responseType;
      extension = responseType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    } catch {
      bytes = null;
    }
  }

  if (!bytes) {
    try {
      bytes = await generateAiProductImage({
        name: input.name,
        productKind: input.productKind,
        region: input.region,
      });
    } catch (error) {
      logger.warn(
        { err: error, productName: input.name },
        "AI product image generation failed; using local fallback",
      );
      const cleanName = input.name
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 110);
      const subtitle = `${input.productKind === "key" ? "DIGITAL KEY" : "STEAM GIFT"}  •  ${input.region || "GLOBAL"}`;
      const { stdout } = await execFileAsync(
        "magick",
        [
          "-size", "1024x1024",
          "gradient:#0f172a-#2563eb",
          "-fill", "#93c5fd",
          "-font", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
          "-pointsize", "36",
          "-gravity", "northwest",
          "-annotate", "+70+75", "DIGITAL PRODUCT",
          "(",
          "-size", "884x470",
          "-background", "none",
          "-fill", "white",
          "-font", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
          "-pointsize", "58",
          "-gravity", "center",
          `caption:${cleanName}`,
          ")",
          "-gravity", "center",
          "-geometry", "+0-10",
          "-composite",
          "-fill", "#bfdbfe",
          "-pointsize", "30",
          "-gravity", "south",
          "-annotate", "+0+75", subtitle,
          "-depth", "8",
          "png:-",
        ],
        { encoding: "buffer", maxBuffer: MAX_IMAGE_BYTES },
      );
      bytes = stdout;
    }
  }

  const uploadBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(uploadBuffer).set(new Uint8Array(bytes));
  const form = new FormData();
  form.append(
    "file",
    new Blob([uploadBuffer], { type: contentType }),
    `product-${productId}.${extension}`,
  );

  const token = providedToken ?? (await loginDigiseller());
  const response = await fetch(
    `https://api.digiseller.com/api/product/preview/add/images/${productId}?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const json = (await response.json()) as AddImageResult;
  if (!response.ok || json.retval !== 0) {
    throw new Error(
      getDigisellerError(json, `Не удалось загрузить изображение (${response.status})`),
    );
  }
}

function getCataloguerSearchName(name: string) {
  return name
    .replace(/^[^A-Za-zА-Яа-я0-9]+/u, "")
    .split("|")[0]
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function normalizeCataloguerName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

type CataloguerCategory = {
  category_id: number;
  name?: Array<{ locale?: string; value?: string }>;
};

type CataloguerAttributeValue = {
  attribute_value_id: number;
  name?: Array<{ locale?: string; value?: string }>;
};

type CataloguerAttribute = {
  attribute_id: number;
  name?: Array<{ locale?: string; value?: string }>;
  values?: CataloguerAttributeValue[];
};

type CataloguerProductAttribute = {
  attribute_id: number;
  attribute_value_id: number;
};

const cataloguerAttributesCache = new Map<number, CataloguerAttribute[]>();

function getLocalizedValues(
  localizedNames: Array<{ locale?: string; value?: string }> | undefined,
) {
  return (localizedNames ?? [])
    .map((entry) => entry.value?.trim())
    .filter((value): value is string => Boolean(value));
}

function includesNormalized(source: string, candidate: string) {
  const normalizedSource = ` ${normalizeCataloguerName(source)} `;
  const normalizedCandidate = normalizeCataloguerName(candidate);
  return (
    normalizedCandidate.length > 0 &&
    normalizedSource.includes(` ${normalizedCandidate} `)
  );
}

async function fetchCataloguerAttributes(
  categoryId: number,
  token: string,
): Promise<CataloguerAttribute[]> {
  const cached = cataloguerAttributesCache.get(categoryId);
  if (cached) return cached;

  const response = await fetch(
    `https://api.digiseller.com/api/cataloguer/${categoryId}/attributes?token=${encodeURIComponent(token)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as {
    retval?: number;
    content?: CataloguerAttribute[];
  };
  if (!response.ok || json.retval !== 0) {
    throw new Error(
      `Не удалось загрузить атрибуты категории Digiseller (${response.status})`,
    );
  }
  const attributes = json.content ?? [];
  cataloguerAttributesCache.set(categoryId, attributes);
  return attributes;
}

export function selectCataloguerAttributes(
  attributes: CataloguerAttribute[],
  input: Pick<ProductInput, "name" | "productType">,
): CataloguerProductAttribute[] {
  const selected: CataloguerProductAttribute[] = [];
  for (const attribute of attributes) {
    const attributeNames = getLocalizedValues(attribute.name).map((name) =>
      normalizeCataloguerName(name),
    );
    const isPlatform = attributeNames.some((name) =>
      ["платформа", "platform"].includes(name),
    );
    const isContentType = attributeNames.some((name) =>
      ["тип контента", "content type"].includes(name),
    );
    const isEdition = attributeNames.some((name) =>
      ["издание", "edition"].includes(name),
    );
    if (!isPlatform && !isContentType && !isEdition) continue;

    const value = (attribute.values ?? []).find((candidate) => {
      const names = getLocalizedValues(candidate.name);
      if (isContentType) {
        const expected =
          input.productType === "1"
            ? ["гифты", "gifts"]
            : ["ключи", "keys"];
        return names.some((name) =>
          expected.includes(normalizeCataloguerName(name)),
        );
      }
      return names.some((name) => includesNormalized(input.name, name));
    });
    if (value) {
      selected.push({
        attribute_id: attribute.attribute_id,
        attribute_value_id: value.attribute_value_id,
      });
    }
  }
  return selected;
}

async function fetchCataloguerCategoryPage(
  page: number,
  token: string,
): Promise<CataloguerCategory[]> {
  const url = new URL("https://api.digiseller.com/api/cataloguer/categories");
  url.searchParams.set("request.page", String(page));
  url.searchParams.set("request.count", "500");
  url.searchParams.set("request.rootCategoryId", "33177");
  url.searchParams.set("token", token);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const json = (await response.json()) as {
        retval?: number;
        content?: CataloguerCategory[];
      };
      if (!response.ok || json.retval !== 0) {
        throw new Error(
          `Не удалось загрузить каталог категорий Digiseller (${response.status})`,
        );
      }
      return json.content ?? [];
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Не удалось загрузить каталог категорий Digiseller");
}

function findBestCataloguerMatch(
  categories: CataloguerCategory[],
  searchName: string,
) {
  const normalizedSearch = normalizeCataloguerName(searchName);
  const candidates = categories.flatMap((category) =>
    (category.name ?? []).map((localizedName) => ({
      category,
      normalizedName: normalizeCataloguerName(localizedName.value ?? ""),
    })),
  );
  const exact = candidates.find(
    (candidate) => candidate.normalizedName === normalizedSearch,
  );
  if (exact) return exact.category;

  return candidates
    .filter(
      (candidate) =>
        candidate.normalizedName.length >= 8 &&
        (normalizedSearch.startsWith(`${candidate.normalizedName} `) ||
          candidate.normalizedName.startsWith(`${normalizedSearch} `) ||
          normalizedSearch.endsWith(` ${candidate.normalizedName}`)),
    )
    .sort(
      (left, right) =>
        right.normalizedName.length - left.normalizedName.length,
    )[0]?.category;
}

function shortlistCataloguerCategories(
  categories: CataloguerCategory[],
  searchName: string,
) {
  const searchTokens = new Set(
    normalizeCataloguerName(searchName)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
  const scored = new Map<number, { id: number; name: string; score: number }>();
  for (const category of categories) {
    for (const localizedName of category.name ?? []) {
      const name = localizedName.value?.trim();
      if (!name) continue;
      const normalizedName = normalizeCataloguerName(name);
      const categoryTokens = normalizedName
        .split(" ")
        .filter((token) => token.length >= 3);
      const overlap = categoryTokens.filter((token) =>
        searchTokens.has(token),
      ).length;
      if (overlap === 0) continue;
      const score =
        overlap * 10 +
        (normalizeCataloguerName(searchName).includes(normalizedName) ? 20 : 0);
      const existing = scored.get(category.category_id);
      if (!existing || score > existing.score) {
        scored.set(category.category_id, {
          id: category.category_id,
          name,
          score,
        });
      }
    }
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 60)
    .map(({ id, name }) => ({ id, name }));
}

async function findCataloguerCategoryId(name: string, token: string): Promise<number> {
  const searchName = getCataloguerSearchName(name);
  const cached = cataloguerCategoryCache.get(searchName);
  if (cached) return cached;

  const pagesPerBatch = 6;
  const allCategories: CataloguerCategory[] = [];
  for (let startPage = 1; startPage <= 60; startPage += pagesPerBatch) {
    const pages = Array.from(
      { length: Math.min(pagesPerBatch, 61 - startPage) },
      (_, index) => startPage + index,
    );
    const results = await Promise.all(
      pages.map((page) => fetchCataloguerCategoryPage(page, token)),
    );
    const categories = results.flat();
    allCategories.push(...categories);
    const match = findBestCataloguerMatch(categories, searchName);
    if (match) {
      cataloguerCategoryCache.set(searchName, match.category_id);
      return match.category_id;
    }
    if (results.some((pageCategories) => pageCategories.length === 0)) break;
  }
  try {
    const aiCategoryId = await selectCategoryWithAi(
      searchName,
      shortlistCataloguerCategories(allCategories, searchName),
    );
    if (aiCategoryId) {
      cataloguerCategoryCache.set(searchName, aiCategoryId);
      return aiCategoryId;
    }
  } catch (error) {
    logger.warn(
      { err: error, productName: name },
      "AI category selection failed",
    );
  }
  throw new Error(`Категория Plati.Market для «${searchName}» не найдена`);
}

type ProductCategory =
  | { owner: 0; category_id: number }
  | {
      owner: 1;
      cataloguer_category_id: number;
      cataloguer_attributes?: CataloguerProductAttribute[];
    };
async function resolveProductCategories(
  input: Pick<ProductInput, "name" | "productType">,
  token: string,
  platiCategoryId?: number | null,
): Promise<ProductCategory[]> {
  if (platiCategoryId) {
    return [{ owner: 0, category_id: platiCategoryId }];
  }
  const cataloguerCategoryId = await findCataloguerCategoryId(input.name, token);
  const cataloguerAttributes = selectCataloguerAttributes(
    await fetchCataloguerAttributes(cataloguerCategoryId, token),
    input,
  );
  return [
    { owner: 0, category_id: 0 },
    {
      owner: 1,
      cataloguer_category_id: cataloguerCategoryId,
      ...(cataloguerAttributes.length > 0
        ? { cataloguer_attributes: cataloguerAttributes }
        : {}),
    },
  ];
}

export async function addDigisellerProductToMarketplaceCategory(
  productId: number,
  categoryId: number,
  providedToken?: string,
): Promise<void> {
  const token = providedToken ?? (await loginDigiseller());
  const response = await fetch(
    `https://api.digiseller.com/api/product/platform/category/add/${productId}/${categoryId}?token=${encodeURIComponent(token)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as {
    retval?: number;
    retdesc?: string;
    errors?: Array<{ message?: string; description?: string }>;
    content?: { status?: string };
  };
  if (
    !response.ok ||
    json.retval !== 0 ||
    json.content?.status !== "success"
  ) {
    throw new Error(
      getDigisellerError(
        json,
        `Не удалось добавить товар в категорию Plati.Market (${response.status})`,
      ),
    );
  }
}

function buildProductPayload(
  input: ProductInput,
  categories: ProductCategory[],
  enabled = true,
  deliveryType?: "form" | "text" | "code",
) {
  const additionalInfoRu =
    input.productType === "1"
      ? "После оплаты укажите ссылку на профиль Steam. Заказ обрабатывается вручную после проверки цены и наличия."
      : "Заказ обрабатывается вручную после проверки цены и наличия у поставщика.";
  const additionalInfoEn =
    input.productType === "1"
      ? "After payment, provide your Steam profile link. The order is processed manually after checking price and availability."
      : "The order is processed manually after checking price and supplier availability.";
  return {
    content_type:
      deliveryType === "text"
        ? "text"
        : input.productType === "2"
          ? "digisellercode"
          : "Form",
    ...(categories.length > 0 ? { categories } : {}),
    name: [
      { locale: "ru-RU", value: input.name.slice(0, 500) },
      { locale: "en-US", value: input.name.slice(0, 500) },
    ],
    description: [
      { locale: "ru-RU", value: input.descriptionRu },
      { locale: "en-US", value: input.descriptionEn },
    ],
    add_info: [
      { locale: "ru-RU", value: additionalInfoRu },
      { locale: "en-US", value: additionalInfoEn },
    ],
    price: { price: Math.ceil(input.priceRub), currency: "RUB" },
    enabled,
    address_required: false,
    online_checkout_name: input.name.slice(0, 128),
    online_checkout_category: "IntellectualPropertyGrant",
    online_checkout_tax: "no_vat",
  };
}

export async function addDigisellerProductToPlati(
  productId: number,
  input: ProductInput,
  providedToken?: string,
  platiCategoryId?: number | null,
  deliveryType?: "form" | "text" | "code",
): Promise<void> {
  const token = providedToken ?? (await loginDigiseller());
  const categories = await resolveProductCategories(input, token, platiCategoryId);
  const payload = buildProductPayload(input, categories, true, deliveryType);
  const productKind =
    deliveryType === "text" ||
    deliveryType === "code" ||
    (!deliveryType && input.productType === "2")
      ? "uniquefixed"
      : "arbitrary";
  const response = await fetch(
    `https://api.digiseller.com/api/product/edit/${productKind}/${productId}?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as CreateProductResult;
  if (!response.ok || json.retval !== 0) {
    throw new Error(
      getDigisellerError(json, `Не удалось добавить товар на Plati.Market (${response.status})`),
    );
  }
}

export async function setDigisellerProductEnabled(
  productId: number,
  input: ProductInput,
  enabled: boolean,
  providedToken?: string,
  platiCategoryId?: number | null,
  deliveryType: "form" | "text" | "code" = "form",
): Promise<void> {
  const token = providedToken ?? (await loginDigiseller());
  const categories = await resolveProductCategories(input, token, platiCategoryId);
  const productKind =
    deliveryType === "text" || deliveryType === "code"
      ? "uniquefixed"
      : "arbitrary";
  const payload = buildProductPayload(input, categories, enabled, deliveryType);
  const response = await fetch(
    `https://api.digiseller.com/api/product/edit/${productKind}/${productId}?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as CreateProductResult;
  if (!response.ok || json.retval !== 0) {
    throw new Error(
      getDigisellerError(
        json,
        `Не удалось ${enabled ? "включить" : "отключить"} товар (${response.status})`,
      ),
    );
  }
}

export async function disableLegacyDigisellerProduct(
  productId: number,
  input: ProductInput,
  providedToken?: string,
  platiCategoryId?: number | null,
  deliveryType: "form" | "text" = "form",
): Promise<void> {
  const token = providedToken ?? (await loginDigiseller());
  const categories = await resolveProductCategories(input, token, platiCategoryId);
  const isUniqueFixed = deliveryType === "text";
  const payload = buildProductPayload(
    { ...input, productType: isUniqueFixed ? "2" : "1" },
    categories,
    false,
    isUniqueFixed ? "text" : "form",
  );
  const response = await fetch(
    `https://api.digiseller.com/api/product/edit/${isUniqueFixed ? "uniquefixed" : "arbitrary"}/${productId}?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as CreateProductResult;
  if (!response.ok || json.retval !== 0) {
    throw new Error(
      getDigisellerError(
        json,
        `Не удалось отключить старый товар (${response.status})`,
      ),
    );
  }
}
