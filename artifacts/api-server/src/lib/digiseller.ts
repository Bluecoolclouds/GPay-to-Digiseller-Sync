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
  const response = await fetch(
    `https://api.digiseller.com/api/product/create/arbitrary?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content_type: "Form",
        categories: [{ owner: 0, category_id: 0 }],
        name: [{ locale: "ru-RU", value: input.name.slice(0, 500) }],
        description: [
          {
            locale: "ru-RU",
            value: input.description,
          },
        ],
        add_info: [
          {
            locale: "ru-RU",
            value: input.productType === "1"
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
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const json = (await response.json()) as CreateProductResult;
  const productId = json.content?.product_id;
  if (!response.ok || json.retval !== 0 || !productId) {
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
    throw new Error(
      details || description || `Digiseller API returned ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return productId;
}