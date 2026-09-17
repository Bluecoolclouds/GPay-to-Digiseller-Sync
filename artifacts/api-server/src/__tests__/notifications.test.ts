import assert from "node:assert/strict";
import test from "node:test";
import { db, notificationStateTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  encryptNotificationWebhook,
  notifyFailure,
  notifyRecovery,
  sanitizeNotificationText,
  setNotificationTransportForTests,
} from "../lib/notifications";

test("notification text removes secrets, URLs and long tokens", () => {
  const cleaned = sanitizeNotificationText(
    "password=hunter2 token=abcdefghijklmnopqrstuvwxyz123456 https://buyer.example/order",
  );
  assert.equal(cleaned.includes("hunter2"), false);
  assert.equal(cleaned.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(cleaned.includes("buyer.example"), false);
});

test("notifications deduplicate failures and send one recovery", async () => {
  const bodies: string[] = [];
  setNotificationTransportForTests(async (_url, text) => {
    bodies.push(text);
  });
  try {
    await db
      .insert(settingsTable)
      .values({
        id: 1,
        notificationWebhookEncrypted: encryptNotificationWebhook(
          "https://example.com/hook",
        ),
      })
      .onConflictDoUpdate({
        target: settingsTable.id,
        set: {
          notificationWebhookEncrypted: encryptNotificationWebhook(
            "https://example.com/hook",
          ),
        },
      });
    await db
      .delete(notificationStateTable)
      .where(eq(notificationStateTable.key, "test:dedupe"));

    assert.equal(
      await notifyFailure({
        key: "test:dedupe",
        title: "Ошибка",
        reason: "password=do-not-send",
      }),
      true,
    );
    assert.equal(
      await notifyFailure({
        key: "test:dedupe",
        title: "Ошибка",
        reason: "password=do-not-send",
      }),
      false,
    );
    assert.equal(await notifyRecovery("test:dedupe", "Процесс"), true);
    assert.equal(await notifyRecovery("test:dedupe", "Процесс"), false);
    assert.equal(bodies.length, 2);
    assert.equal(bodies.some((body) => body.includes("do-not-send")), false);
    assert.match(bodies[1], /ВОССТАНОВЛЕНО/);
  } finally {
    setNotificationTransportForTests(null);
  }
});