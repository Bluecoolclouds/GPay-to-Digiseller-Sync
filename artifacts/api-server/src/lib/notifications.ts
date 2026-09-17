import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { db, notificationStateTable, settingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const REPEAT_AFTER_MS = 60 * 60 * 1_000;
const SECRET_PATTERN =
  /(password|token|secret|api[_ -]?key|authorization|cookie|buyer|email)\s*[:=]\s*\S+/gi;

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

export function encryptNotificationWebhook(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptNotificationWebhook(value: string) {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid notification channel");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sanitizeNotificationText(value: unknown) {
  const text = value instanceof Error ? value.message : String(value ?? "Неизвестная ошибка");
  return text
    .replace(
      /["']?(password|token|secret|api[_ -]?key|authorization|cookie|buyer|email)["']?\s*:\s*["'][^"']*["']/gi,
      "$1=[СКРЫТО]",
    )
    .replace(SECRET_PATTERN, "$1=[СКРЫТО]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL СКРЫТ]")
    .replace(/(?:\+?\d[\s().-]*){10,}/g, "[НОМЕР СКРЫТ]")
    .replace(/\b\d{8,}\b/g, "[КОД СКРЫТ]")
    .replace(/https?:\/\/\S+/gi, "[ССЫЛКА СКРЫТА]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[СКРЫТО]")
    .slice(0, 700);
}

export async function ensureNotificationSchema() {
  await db.execute(`
    alter table sync_settings
      add column if not exists notification_webhook_encrypted text;
    create table if not exists sync_notification_state (
      key text primary key,
      active boolean not null default false,
      fingerprint text,
      last_notified_at timestamptz,
      last_recovered_at timestamptz,
      updated_at timestamptz not null default now()
    )
  `);
}

async function webhookUrl() {
  const [settings] = await db
    .select({ encrypted: settingsTable.notificationWebhookEncrypted })
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));
  return settings?.encrypted
    ? decryptNotificationWebhook(settings.encrypted)
    : null;
}

type NotificationTransport = (url: URL, text: string) => Promise<void>;

async function secureTransport(url: URL, text: string) {
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Адрес канала ведёт во внутреннюю сеть");
  }
  const pinned = addresses[0];
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ text });
    const outgoing = request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      servername: url.hostname,
      lookup: (_hostname, _options, callback) =>
        callback(null, pinned.address, pinned.family),
      timeout: 10_000,
    }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        reject(new Error("Канал уведомлений не должен перенаправлять запрос"));
      } else if (status < 200 || status >= 300) {
        reject(new Error(`Канал уведомлений вернул HTTP ${status}`));
      } else {
        resolve();
      }
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("Таймаут канала уведомлений")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

let notificationTransport: NotificationTransport = secureTransport;

export function setNotificationTransportForTests(
  transport: NotificationTransport | null,
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test notification transport is only available in tests");
  }
  notificationTransport = transport ?? secureTransport;
}

async function deliver(text: string) {
  const url = await webhookUrl();
  if (!url) return false;
  const parsed = new URL(url);
  await validateNotificationWebhookUrl(parsed);
  await notificationTransport(parsed, text);
  return true;
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice(7));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

export async function validateNotificationWebhookUrl(value: URL | string) {
  const parsed = typeof value === "string" ? new URL(value) : value;
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") {
    throw new Error("Канал уведомлений должен использовать HTTPS");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw new Error("Внутренний адрес нельзя использовать для уведомлений");
  }
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Адрес канала ведёт во внутреннюю сеть");
  }
  return parsed;
}

export async function testNotificationChannel() {
  const delivered = await deliver(
    `Проверка уведомлений выполнена успешно\nВремя: ${new Date().toISOString()}`,
  );
  if (!delivered) throw new Error("Канал уведомлений не настроен");
}

export async function notifyFailure(input: {
  key: string;
  title: string;
  reason: unknown;
  lastSuccessfulAt?: Date | null;
}) {
  try {
    const now = new Date();
    const reason = sanitizeNotificationText(input.reason);
    const fingerprint = createHash("sha256").update(reason).digest("hex");
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.key}))`,
      );
      const [state] = await tx
        .select()
        .from(notificationStateTable)
        .where(eq(notificationStateTable.key, input.key));
      const suppressed =
        state?.active &&
        state.fingerprint === fingerprint &&
        state.lastNotifiedAt &&
        now.getTime() - state.lastNotifiedAt.getTime() < REPEAT_AFTER_MS;
      if (suppressed) return false;
      const delivered = await deliver(
        [
          `ТРЕБУЕТСЯ ВНИМАНИЕ: ${sanitizeNotificationText(input.title)}`,
          `Причина: ${reason}`,
          `Время: ${now.toISOString()}`,
          ...(input.lastSuccessfulAt
            ? [`Последний успех: ${input.lastSuccessfulAt.toISOString()}`]
            : []),
        ].join("\n"),
      );
      await tx
        .insert(notificationStateTable)
        .values({
          key: input.key,
          active: true,
          fingerprint,
          lastNotifiedAt: delivered ? now : state?.lastNotifiedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: notificationStateTable.key,
          set: {
            active: true,
            fingerprint,
            ...(delivered ? { lastNotifiedAt: now } : {}),
            updatedAt: now,
          },
        });
      return delivered;
    });
  } catch (error) {
    logger.error(
      { notificationKey: input.key, err: sanitizeNotificationText(error) },
      "Operational notification delivery failed",
    );
    return false;
  }
}

export async function notifyRecovery(key: string, title: string) {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      const [state] = await tx
        .select()
        .from(notificationStateTable)
        .where(eq(notificationStateTable.key, key));
      if (!state?.active) return false;
      const now = new Date();
      const delivered = await deliver(
        `ВОССТАНОВЛЕНО: ${sanitizeNotificationText(title)}\nВремя: ${now.toISOString()}`,
      );
      if (delivered) {
        await tx
          .update(notificationStateTable)
          .set({
            active: false,
            fingerprint: null,
            lastRecoveredAt: now,
            updatedAt: now,
          })
          .where(eq(notificationStateTable.key, key));
      }
      return delivered;
    });
  } catch (error) {
    logger.error(
      { notificationKey: key, err: sanitizeNotificationText(error) },
      "Operational recovery notification failed",
    );
    return false;
  }
}