export function redactSensitiveRequestUrl(rawUrl?: string) {
  return rawUrl
    ?.split("?")[0]
    ?.replace(
      /\/api\/public\/orders\/[^/]+/,
      "/api/public/orders/[redacted]",
    );
}