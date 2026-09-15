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
  }> | null;
  errorMessage?: string | null;
};

type WholesaleKeysOrderStatusResponse = {
  orderId: number;
  uniqueCode?: string | null;
  deliveryStatus?: string | null;
  isTerminal: boolean;
  errorMessage?: string | null;
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
  return {
    orderId: result.orderId,
    uniqueCode: result.uniqueCode || uniqueCode,
    deliveryStatus: result.deliveryStatus || "processing",
    isTerminal: result.isTerminal,
    errorMessage: result.errorMessage ?? null,
  };
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
  const productType =
    productKind === "key" ? 2 : productKind === "gift" ? 1 : undefined;

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
  const totalPages = Math.ceil(firstPage.totalCount / pageSize);
  const productsById = new Map<number, GPayProduct>();
  const addProducts = (products: GPayProduct[] | null | undefined) => {
    for (const product of products ?? []) {
      if (!productsById.has(product.id)) productsById.set(product.id, product);
    }
  };
  addProducts(firstPage.products);
  const concurrency = 5;

  for (let start = 2; start <= totalPages; start += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, totalPages - start + 1) },
      (_, index) => start + index,
    );
    const results = await Promise.all(pages.map(fetchPage));
    for (const result of results) addProducts(result.products);
  }

  return {
    ...firstPage,
    products: [...productsById.values()],
    page: 1,
    pageSize,
  };
}