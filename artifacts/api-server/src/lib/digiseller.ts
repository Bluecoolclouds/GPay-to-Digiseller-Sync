import { createHash } from "node:crypto";

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

type ProductInput = {
  name: string;
  description: string;
  priceRub: number;
  productType: string;
};

const cataloguerCategoryCache = new Map<string, number>();

function getDigisellerError(json: CreateProductResult, fallback: string) {
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

export async function createDigisellerProduct(input: {
  name: string;
  description: string;
  priceRub: number;
  productType: string;
}): Promise<number> {
  const token = await loginDigiseller();
  const cataloguerCategoryId = await findCataloguerCategoryId(input.name, token);
  const payload = buildProductPayload(input, cataloguerCategoryId);
  const response = await fetch(
    `https://api.digiseller.com/api/product/create/arbitrary?token=${encodeURIComponent(token)}`,
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

function getCataloguerSearchName(name: string) {
  return name
    .replace(/^[^A-Za-zА-Яа-я0-9]+/u, "")
    .split("|")[0]
    .trim()
    .toLocaleLowerCase("ru-RU");
}

async function findCataloguerCategoryId(name: string, token: string): Promise<number> {
  const searchName = getCataloguerSearchName(name);
  const cached = cataloguerCategoryCache.get(searchName);
  if (cached) return cached;

  for (let page = 1; page <= 60; page++) {
    const url = new URL("https://api.digiseller.com/api/cataloguer/categories");
    url.searchParams.set("request.page", String(page));
    url.searchParams.set("request.count", "500");
    url.searchParams.set("request.rootCategoryId", "33177");
    url.searchParams.set("token", token);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const json = (await response.json()) as {
      retval?: number;
      content?: Array<{
        category_id: number;
        name?: Array<{ locale?: string; value?: string }>;
      }>;
    };
    if (!response.ok || json.retval !== 0) {
      throw new Error(`Не удалось загрузить каталог категорий Digiseller (${response.status})`);
    }
    const categories = json.content ?? [];
    const match = categories.find((category) =>
      category.name?.some(
        (localizedName) =>
          localizedName.value?.trim().toLocaleLowerCase("ru-RU") === searchName,
      ),
    );
    if (match) {
      cataloguerCategoryCache.set(searchName, match.category_id);
      return match.category_id;
    }
    if (categories.length === 0) break;
  }
  throw new Error(`Категория Plati.Market для «${searchName}» не найдена`);
}

function buildProductPayload(input: ProductInput, cataloguerCategoryId: number) {
  return {
    content_type: "Form",
    categories: [
      { owner: 0, category_id: 0 },
      { owner: 1, cataloguer_category_id: cataloguerCategoryId },
    ],
    name: [{ locale: "ru-RU", value: input.name.slice(0, 500) }],
    description: [{ locale: "ru-RU", value: input.description }],
    add_info: [
      {
        locale: "ru-RU",
        value:
          input.productType === "1"
            ? "После оплаты укажите ссылку на профиль Steam. Заказ обрабатывается вручную после проверки цены и наличия."
            : "Заказ обрабатывается вручную после проверки цены и наличия у поставщика.",
      },
    ],
    price: { price: Math.ceil(input.priceRub), currency: "RUB" },
    enabled: true,
    address_required: false,
    online_checkout_name: input.name.slice(0, 128),
    online_checkout_category: "IntellectualPropertyGrant",
    online_checkout_tax: "no_vat",
  };
}

export async function addDigisellerProductToPlati(
  productId: number,
  input: ProductInput,
): Promise<void> {
  const token = await loginDigiseller();
  const categoryId = await findCataloguerCategoryId(input.name, token);
  const payload = buildProductPayload(input, categoryId);
  const response = await fetch(
    `https://api.digiseller.com/api/product/edit/arbitrary/${productId}?token=${encodeURIComponent(token)}`,
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