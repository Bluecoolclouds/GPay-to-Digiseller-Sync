import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

export function encryptImageProviderApiKey(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptImageProviderApiKey(value: string) {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid image provider key");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export async function getImageProviderConfig() {
  const [settings] = await db
    .select({
      name: settingsTable.imageProviderName,
      baseUrl: settingsTable.imageProviderBaseUrl,
      model: settingsTable.imageProviderModel,
      encryptedKey: settingsTable.imageProviderApiKeyEncrypted,
    })
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));
  return {
    name: settings?.name || "APINET",
    baseUrl: (settings?.baseUrl || process.env.APINET_BASE_URL || "https://apinet.cloud").replace(/\/+$/, ""),
    model: settings?.model || "gpt-image-2",
    apiKey: settings?.encryptedKey
      ? decryptImageProviderApiKey(settings.encryptedKey)
      : process.env.APINET_API_KEY,
  };
}