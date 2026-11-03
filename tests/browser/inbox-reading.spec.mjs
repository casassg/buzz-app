import { test, expect } from "./fixture.mjs";
import { inboxName } from "./navigation.mjs";
import { open, settle, virtuaIdle } from "./timeline.mjs";
import {
  holdReadingFocus,
  releaseReadingFocus,
  readJournal,
} from "./reading.mjs";

// Browser-only contract: the actual Inbox DM tab joins its native composer
// focus to fully visible timeline rows. RTL cannot establish viewport/focus dwell.
test.use({
  productionBroker: true,
  readState: true,
  inboxDm: true,
  pluginFixtures: true, // Read-only shared-owner readiness/observation barriers.
  historyCounts: { alpha: 1, beta: 1 },
});

test("Inbox DM composer focus reads a visible peer arrival after dwell without reselecting", async ({
  page,
  app,
}) => {
  await holdReadingFocus(page);
  await open(page, app);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const sync = window.fixtureRelay.snapshot().session.unread.sync();
        return { status: sync.status, completeness: sync.completeness };
      }),
    )
    .toEqual({ status: "reconciled", completeness: "snapshot" });
  await page.getByRole("button", { name: inboxName }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const dm = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Inbox DM fixture reply" });
  await expect(dm.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);

  // Give the next fixture arrival a timestamp beyond the captured selection
  // cutoff without moving the browser outside the broker's signing clock.
  const base = Date.now();
  const cutoff = Math.floor(base / 1000);
  const selected = app.histories.get("primary/dm-peer").at(-1);
  const seed = app.sign({
    kind: 9,
    created_at: cutoff,
    tags: [["h", "dm-peer"]],
    content: "Our current DM context",
  });
  app.histories.get("primary/dm-peer").push(seed);
  app.relay.publish("primary", seed);
  await page.clock.setFixedTime(base);
  await releaseReadingFocus(page);
  await dm.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  const history = detail.getByRole("region", {
    name: "Channel message history",
  });
  // A DM opens whole, at its latest messages.
  const selectedRow = history.locator(`[data-message-id="${selected.id}"]`);
  await expect(selectedRow).toBeInViewport({ ratio: 1 });
  // Finish the opening frames before moving focus to the composer or
  // installing the dwell clock.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await virtuaIdle(page, history);
  await expect
    .poll(async () => (await readJournal(page)).state.frontiers["dm-peer"])
    .toBe(cutoff);
  await expect(dm.getByRole("img", { name: "Unread" })).toHaveCount(0);

  const filter = inbox.getByRole("button", {
    name: "Inbox filters",
    exact: true,
  });
  await filter.focus();
  await page.clock.install({ time: base });
  await page.clock.pauseAt(base + 20_000);
  const composer = detail.getByRole("textbox", { name: /^Message / });
  const draft = "Unsent Inbox DM draft";
  await composer.fill(draft);
  await expect(composer).toBeFocused();

  const incoming = app.append(
    "primary",
    "dm-peer",
    "Visible incoming Inbox DM",
    true,
    false,
  );
  expect(incoming.created_at).toBeGreaterThan(cutoff);
  const arrival = history.locator(`[data-message-id="${incoming.id}"]`);
  await expect(arrival).toBeInViewport({ ratio: 1 });
  // Let the timeline's positioning frame run, not its 300ms reading deadline.
  await page.clock.runFor(16);
  await settle(page, history);
  await expect(composer).toBeFocused();
  const dmRow = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: incoming.content });
  await expect(dmRow.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("dm-peer", id)
            .viewing,
        incoming.id,
      ),
    )
    .toBe(true);

  // Restart dwell through native focus after positioning is observed. This
  // makes 299/300ms exact rather than depending on which frame placed the row.
  await filter.focus();
  await composer.focus();
  await page.clock.runFor(299);
  expect((await readJournal(page)).state.frontiers["dm-peer"]).toBe(cutoff);
  await expect(dmRow.getByRole("img", { name: "Unread" })).toBeVisible();
  await page.clock.runFor(1);
  // Reading a DM reads all of it, through the newest message, with one
  // channel mark rather than a mark per message.
  await expect
    .poll(async () => (await readJournal(page)).state.frontiers["dm-peer"])
    .toBe(incoming.created_at);
  await expect(dmRow.getByRole("img", { name: "Unread" })).toHaveCount(0);
  expect(
    (await readJournal(page)).state.frontiers[`msg:${incoming.id}`],
  ).toBeUndefined();
  // Reading must not recreate the composer/draft as the Inbox row's
  // representative changes.
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText(draft);
  await page.clock.resume();
});
