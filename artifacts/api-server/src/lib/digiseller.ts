import { createHash } from "node:crypto";

type DigiLoginResponse = {
  token?: string;
  retval?: number;
  desc?: string;
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