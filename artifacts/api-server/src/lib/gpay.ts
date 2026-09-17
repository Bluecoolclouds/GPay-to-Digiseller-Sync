type GPayEnvelope<T> = {
  status?: string | null;
  errorCode?: number;
  errorMessage?: string | null;
  data?: T | null;
};

export type GPayKeyPurchase = {
  orderId: number | null;
  uniqueCode: string;
  deliveryStatus: string;
  isTerminal: boolean;
  errorMessage: string | null;
  deliveredKey: string | null;
};

export class GPayPurchaseAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPayPurchaseAmbiguousError";
  }
}

export class GPayPurchaseRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPayPurchaseRejectedError";
  }
}

export class GPayPurchaseUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPayPurchaseUnauthorizedError";
  }
}

type WholesaleKeysOrderResponse = {
  success: boolean;
  items?: Array<{
    orderId?: number | null;
    uniqueCode?: string | null;
    isSuccess: boolean;
    deliveryStatus?: string | null;
    errorMessage?: string | null;
    key?: string | null;
    activationKey?: string | null;
    productKey?: string | null;
    deliveryData?: string | null;
  }> | null;
  errorMessage?: string | null;
};

type WholesaleKeysOrderStatusResponse = {
  orderId: number;
  uniqueCode?: string | null;
  deliveryStatus?: string | null;
  isTerminal: boolean;
  errorMessage?: string | null;
  key?: string | null;
  activationKey?: string | null;
  productKey?: string | null;
  deliveryData?: string | null;
};

function extractDeliveredKey(input: {
  key?: string | null;
  activationKey?: string | null;
  productKey?: string | null;
  deliveryData?: string | null;
}) {
  const candidates = [
    input.key,
    input.activationKey,
    input.productKey,
    input.deliveryData,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) {
    throw new Error("GPay returned conflicting delivered key values");
  }
  return distinct[0] ?? null;
}

export type GPayPartnerOrder = {
  id: number;
  uniqueCode?: string | null;
  productType: number;
  itemId?: number | null;
  totalAmount: number;
  createdAt: string;
};

type PartnersOrdersListResponse = {
  orders?: GPayPartnerOrder[] | null;
  totalCount: number;
  page: number;
  pageSize: number;
};

export type GPayProduct = {
  id: number;
  appId?: number | null;
  subId?: number | null;
  name: string;
  imageUrl?: string | null;
  productType: string | number;
  currentPartnerPrice: number;
  isAvailable?: boolean | null;
  warningMessage?: string | null;
  region?: string | null;
};

export type GPayProductKind = "key" | "gift" | "unknown";

export function classifyGPayProductType(
  productType: string | number,
): GPayProductKind {
  const normalized = String(productType).trim();
  if (normalized === "2") return "key";
  if (normalized === "1") return "gift";
  return "unknown";
}

type LoginData = { token?: string | null; expiresAt: string };
type ProductData = {
  products?: GPayProduct[] | null;
  totalCount: number;
  page: number;
  pageSize: number;
};

const baseUrl = "https://gpay.market";

async function parseResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as GPayEnvelope<T>;
  if (!response.ok || json.status === "error" || !json.data) {
    throw new Error(json.errorMessage || `GPay API returned ${response.status}`);
  }
  return json.data;
}

async function authenticatedGPayRequest<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const token = await loginGPay();
  return authenticatedGPayRequestWithToken<T>(token, path, init, timeoutMs);
}

async function authenticatedGPayRequestWithToken<T>(
  token: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseResponse<T>(response);
}

export async function purchaseGPayKey(
  productId: number,
  token: string,
): Promise<GPayKeyPurchase> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/partner-api/keys/order`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        productId,
        quantity: 1,
        instantDelivery: true,
        disableOrderOnPriceIncrease: 0.01,
        activationTime: null,
        prohibitPromotions: true,
        removeContacts: true,
        generateDirectLinks: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new GPayPurchaseAmbiguousError(
      error instanceof Error ? error.message : "GPay purchase response was not received",
    );
  }
  let envelope: GPayEnvelope<WholesaleKeysOrderResponse>;
  try {
    envelope = (await response.json()) as GPayEnvelope<WholesaleKeysOrderResponse>;
  } catch {
    throw new GPayPurchaseAmbiguousError("GPay purchase returned an unreadable response");
  }
  if (response.status === 401) {
    throw new GPayPurchaseUnauthorizedError(
      envelope.errorMessage || "GPay rejected the access token",
    );
  }
  if (response.status === 400) {
    throw new GPayPurchaseRejectedError(
      envelope.errorMessage || `GPay API returned ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new GPayPurchaseAmbiguousError(
      envelope.errorMessage || `GPay API returned ${response.status}`,
    );
  }
  if (envelope.status === "error" || !envelope.data) {
    throw new GPayPurchaseRejectedError(
      envelope.errorMessage || "GPay key order was rejected",
    );
  }
  const result = envelope.data;
  const item = result.items?.[0];
  if (!result.success || !item?.isSuccess || !item.uniqueCode) {
    throw new GPayPurchaseRejectedError(
      item?.errorMessage || result.errorMessage || "GPay key order was rejected",
    );
  }
  return {
    orderId: item.orderId ?? null,
    uniqueCode: item.uniqueCode,
    deliveryStatus: item.deliveryStatus || "processing",
    isTerminal: item.deliveryStatus === "delivered" || item.deliveryStatus === "failed",
    errorMessage: item.errorMessage ?? null,
    deliveredKey: extractDeliveredKey(item),
  };
}

export async function fetchGPayKeyPurchaseStatus(
  uniqueCode: string,
): Promise<GPayKeyPurchase> {
  const result = await authenticatedGPayRequest<WholesaleKeysOrderStatusResponse>(
    `/partner-api/keys/orders/${encodeURIComponent(uniqueCode)}`,
    { method: "GET" },
    30_000,
  );
  if (result.uniqueCode !== undefined && result.uniqueCode !== uniqueCode) {
    throw new Error("GPay returned a status for a different purchase");
  }
  return {
    orderId: result.orderId,
    uniqueCode,
    deliveryStatus: result.deliveryStatus || "processing",
    isTerminal: result.isTerminal,
    errorMessage: result.errorMessage ?? null,
    deliveredKey: extractDeliveredKey(result),
  };
}

export async function fetchGPayKeyOrderHistory(
  pageSize = 100,
): Promise<GPayPartnerOrder[]> {
  const token = await loginGPay();
  const fetchPage = (page: number, requestedPageSize: number) =>
    authenticatedGPayRequestWithToken<PartnersOrdersListResponse>(
      token,
      "/partner-api/orders/list",
      {
        method: "POST",
        body: JSON.stringify({
          page,
          pageSize: requestedPageSize,
          productType: 2,
        }),
      },
      30_000,
    );

  const readCompleteSnapshot = async () => {
    const firstPage = await fetchPage(1, pageSize);
    const effectivePageSize = firstPage.pageSize;
    if (
      firstPage.page !== 1 ||
      !Number.isInteger(effectivePageSize) ||
      effectivePageSize <= 0 ||
      firstPage.totalCount < 0
    ) {
      throw new Error("GPay вернул некорректную пагинацию истории");
    }
    const totalPages = Math.ceil(firstPage.totalCount / effectivePageSize);
    if (totalPages > 100) {
      throw new Error(
        "История GPay слишком велика для полной безопасной сверки",
      );
    }
    const orders = [...(firstPage.orders ?? [])];
    for (let page = 2; page <= totalPages; page++) {
      const result = await fetchPage(page, effectivePageSize);
      if (
        result.page !== page ||
        result.pageSize !== effectivePageSize ||
        result.totalCount !== firstPage.totalCount
      ) {
        throw new Error("История GPay изменилась во время сверки");
      }
      orders.push(...(result.orders ?? []));
    }
    const unique = new Map(orders.map((order) => [order.id, order]));
    if (unique.size !== orders.length || orders.length !== firstPage.totalCount) {
      throw new Error("Не удалось получить полный снимок истории GPay");
    }
    return [...unique.values()];
  };

  const first = await readCompleteSnapshot();
  const second = await readCompleteSnapshot();
  const fingerprint = (orders: GPayPartnerOrder[]) =>
    orders
      .map((order) =>
        [
          order.id,
          order.uniqueCode ?? "",
          order.productType,
          order.itemId ?? "",
          order.totalAmount,
          order.createdAt,
        ].join("|"),
      )
      .sort()
      .join("\n");
  if (fingerprint(first) !== fingerprint(second)) {
    throw new Error("История GPay изменилась между проверками");
  }
  return second;
}

export async function loginGPay(): Promise<string> {
  const login = process.env.GPAY_LOGIN;
  const password = process.env.GPAY_PASSWORD;
  if (!login || !password) throw new Error("GPay credentials are not configured");

  const response = await fetch(`${baseUrl}/partner-api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await parseResponse<LoginData>(response);
  if (!data.token) throw new Error("GPay did not return an access token");
  return data.token;
}

export async function fetchGPayProducts(
  pageSize = 100,
  productKind: "all" | "key" | "gift" = "all",
): Promise<ProductData> {
  const token = await loginGPay();
  const requestedTypes =
    productKind === "all"
      ? [1, 2]
      : [productKind === "key" ? 2 : 1];

  const fetchCatalog = async (productType: number) => {
    const fetchPage = async (page: number) => {
      const response = await fetch(`${baseUrl}/partner-api/products/list`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ page, pageSize, productType }),
        signal: AbortSignal.timeout(30_000),
      });
      return parseResponse<ProductData>(response);
    };

    const firstPage = await fetchPage(1);
      if (
        firstPage.page !== 1 ||
        firstPage.pageSize !== pageSize ||
        !Number.isInteger(firstPage.totalCount) ||
        firstPage.totalCount < 0
      ) {
        throw new Error("GPay вернул некорректную пагинацию каталога");
      }
    const catalogProducts = [...(firstPage.products ?? [])];
    const totalPages = Math.ceil(firstPage.totalCount / pageSize);
    const concurrency = 5;

    for (let start = 2; start <= totalPages; start += concurrency) {
      const pages = Array.from(
        { length: Math.min(concurrency, totalPages - start + 1) },
        (_, index) => start + index,
      );
      const results = await Promise.all(pages.map(fetchPage));
      for (const [index, result] of results.entries()) {
        const expectedPage = pages[index];
        if (
          result.page !== expectedPage ||
          result.pageSize !== pageSize ||
          result.totalCount !== firstPage.totalCount
        ) {
          throw new Error("Каталог GPay изменился или был получен не полностью");
        }
        catalogProducts.push(...(result.products ?? []));
      }
    }
    if (catalogProducts.length !== firstPage.totalCount) {
      throw new Error("Каталог GPay получен не полностью");
    }
    const identities = new Set(
      catalogProducts.map(
        (product) => `${String(product.productType).trim()}:${product.id}`,
      ),
    );
    if (identities.size !== firstPage.totalCount) {
      throw new Error(
        "Каталог GPay содержит повторяющиеся товары и не является полным снимком",
      );
    }
    return { firstPage, products: catalogProducts };
  };

  const catalogs = await Promise.all(requestedTypes.map(fetchCatalog));
  const productsById = new Map<string, GPayProduct>();
  for (const catalog of catalogs) {
    for (const product of catalog.products) {
      const identity = `${String(product.productType).trim()}:${product.id}`;
      if (!productsById.has(identity)) productsById.set(identity, product);
    }
  }
  const firstPage = catalogs[0].firstPage;

  return {
    ...firstPage,
    products: [...productsById.values()],
    totalCount: productsById.size,
    page: 1,
    pageSize,
  };
}
