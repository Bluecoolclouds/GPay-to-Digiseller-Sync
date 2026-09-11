type GPayEnvelope<T> = {
  status?: string | null;
  errorCode?: number;
  errorMessage?: string | null;
  data?: T | null;
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
  const products = [...(firstPage.products ?? [])];
  const concurrency = 5;

  for (let start = 2; start <= totalPages; start += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, totalPages - start + 1) },
      (_, index) => start + index,
    );
    const results = await Promise.all(pages.map(fetchPage));
    for (const result of results) products.push(...(result.products ?? []));
  }

  return {
    ...firstPage,
    products,
    page: 1,
    pageSize,
  };
}