import { test, expect } from "./fixture.mjs";
import { inboxName } from "./navigation.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Real shell/plugin routing and visible retained reader, beyond direct remount tests.
test("Inbox restores its conversation after visiting Messages and another page", async ({
  page,
  app,
}) => {
  await open(page, app);
  const inboxButton = page.getByRole("button", { name: inboxName });
  await inboxButton.click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click();
  const tab = inbox.getByRole("tab", { name: "Thread root 1", exact: true });
  const reader = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(reader).toBeVisible();
  for (const destination of ["Messages", "Reminders"]) {
    await page.getByRole("tab", { name: destination, exact: true }).click();
    await expect(inbox).toHaveCount(0);
    await inboxButton.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(reader).toBeVisible();
    await expect(row).toHaveAttribute("data-selected");
  }
  await inbox
    .getByRole("button", { name: "Close Thread root 1 tab", exact: true })
    .click();
  await expect(tab).toHaveCount(0);
  await page.getByRole("tab", { name: "Reminders", exact: true }).click();
  await expect(inbox).toHaveCount(0);
  await inboxButton.click();
  await expect(
    inbox.getByRole("list", { name: "Inbox conversations" }),
  ).toBeVisible();
  await expect(tab).toHaveCount(0);
});
