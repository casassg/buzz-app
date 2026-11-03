import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage, inboxName } from "./navigation.mjs";

// Browser-only contract: actual sidebar/plugin routing -> exact thread target,
// browser history, and responsive/light-dark CSS. Matrices stay in RTL/unread tests.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

test("Inbox opens the exact thread, shares read state, and fits the workspace", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const inboxButton = page.getByRole("button", { name: inboxName });
  await inboxButton.click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  // The unselected list must keep the full scroll area after grid simplification.
  const workspace = inbox.locator('[class*="listPane"]').locator("xpath=..");
  await expect
    .poll(
      async () =>
        (await inbox.locator('[class*="listPane"]').boundingBox()).height,
    )
    .toBe((await workspace.boundingBox()).height);
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  const filter = inbox.getByRole("button", {
    name: "Inbox filters",
    exact: true,
  });
  const unread = inbox.getByRole("button", {
    name: "Unread only",
    exact: true,
  });
  const filters = page.getByRole("menu", {
    name: "Inbox filters",
    exact: true,
  });
  const chooseFilter = async (label) => {
    await filter.click();
    await filters
      .getByRole("menuitemradio", { name: label, exact: true })
      .click();
    await expect(filters).not.toBeVisible();
  };
  // The list is the page's only tab until a row opens a conversation beside it.
  await expect(inbox.getByRole("tab")).toHaveText(["Inbox"]);
  await expect(
    inbox.getByRole("navigation", { name: "Inbox history" }),
  ).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Newer activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Load older activity", exact: true }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("combobox")).toHaveCount(0);
  await expect(filter).toHaveText("All");
  const expectBareUnread = async () => {
    await expect(unread).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(unread).toHaveCSS("background-image", "none");
    await expect(unread).toHaveCSS("box-shadow", "none");
    await expect(unread).toHaveCSS("width", "32px");
    await expect(unread).toHaveCSS("height", "32px");
    await expect(unread.locator("svg")).toHaveCSS("width", "20px");
    await expect(unread.locator("svg")).toHaveCSS("height", "20px");
  };
  const toggleUnreadWithPointer = async (selected) => {
    await filter.hover();
    await expectBareUnread(); // Resting, including the selected state.
    await unread.hover();
    await expectBareUnread();
    await expect(
      page.getByRole("tooltip", { name: "Show unread only", exact: true }),
    ).toBeVisible();
    await page.mouse.down();
    try {
      await expect
        .poll(() => unread.evaluate((element) => element.matches(":active")))
        .toBe(true);
      await expectBareUnread(); // Real pointer-pressed state, not aria-pressed.
    } finally {
      await page.mouse.up();
    }
    await expect(unread).toHaveAttribute("aria-pressed", String(selected));
    await expect(unread.locator("svg")).toHaveAttribute(
      "fill",
      selected ? "currentColor" : "none",
    );
    await filter.hover();
    await expectBareUnread();
  };
  await expect(unread).toHaveAttribute("aria-pressed", "false");
  await expect(unread.locator("svg")).toHaveAttribute("fill", "none");
  await toggleUnreadWithPointer(true);
  await toggleUnreadWithPointer(false);
  await filter.click();
  const people = filters.getByRole("menuitemcheckbox", {
    name: "People",
    exact: true,
  });
  const agents = filters.getByRole("menuitemcheckbox", {
    name: "Agents",
    exact: true,
  });
  const expectMenuSelection = async (selectedLabel) => {
    // Move outside the popup: a hovered unchecked row must not be mistaken for
    // persistent radio selection styling.
    await filter.hover();
    const radios = filters.getByRole("menuitemradio");
    await expect(radios).toHaveCount(7);
    await expect(radios.locator("svg")).toHaveCount(0);
    const selected = filters.getByRole("menuitemradio", {
      name: selectedLabel,
      exact: true,
    });
    const unchecked = filters.getByRole("menuitemradio", {
      name: "DMs",
      exact: true,
    });
    await expect(selected).toBeChecked();
    await expect(unchecked).not.toBeChecked();
    await expect(selected).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(unchecked).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(people).toBeChecked();
    await expect(agents).toBeChecked();
    for (const checkbox of [people, agents]) {
      await expect(checkbox.locator("svg")).toHaveCount(1);
      await expect(checkbox.locator("svg")).toBeVisible();
    }
    for (const label of ["Status", "Type", "From"]) {
      const metadata = filters.getByText(label, { exact: true });
      await expect(metadata).toHaveAttribute("data-emphasis", "quiet");
      await expect(metadata).not.toHaveCSS(
        "color",
        await people.evaluate((element) => getComputedStyle(element).color),
      );
      await expect(metadata).toHaveCSS(
        "font-weight",
        await people.evaluate(
          (element) => getComputedStyle(element).fontWeight,
        ),
      );
    }
  };
  await expect(
    filters.getByRole("menuitemcheckbox", { name: "Agents", exact: true }),
  ).toBeInViewport();
  await expect(
    filters.getByRole("menuitemradio", { name: "Drafts", exact: true }),
  ).toBeInViewport();
  await expectMenuSelection("All");
  await page.keyboard.press("Escape");
  await expect(filter).toBeFocused();
  await expect(
    inbox.getByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit/,
    ),
  ).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Mark shown as read" }),
  ).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await chooseFilter("DMs");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Inbox DM fixture reply");
  const dmSource = rows.first().locator("[data-inbox-source]");
  await expect(dmSource).toHaveText("DM · Alice Fixture");
  await expect(dmSource.locator("svg")).toHaveCount(0);
  const dmStyle = await dmSource.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
    inset: getComputedStyle(element).paddingInlineStart,
  }));
  await chooseFilter("Mentions");
  await expect(page.getByText("Activity", { exact: true })).toHaveCount(0);
  await filter.click();
  await agents.click();
  await expect(people).toBeChecked();
  await expect(people).toBeDisabled();
  await expect(rows).toHaveCount(2);
  await agents.click();
  await people.click();
  await expect(agents).toBeChecked();
  await expect(agents).toBeDisabled();
  await expect(rows).toHaveCount(0);
  await people.click();
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(2);
  // Main's fixture now also mentions the viewer in the other thread's nested
  // reply. Keep both groups and select this exact preview, not a namesake row.
  const mentionRow = rows.filter({ hasText: "Unread reply 1" });
  await expect(rows.filter({ hasText: "Broadcast descendant" })).toHaveCount(1);
  const source = mentionRow.locator("[data-inbox-source]");
  await expect(source).toHaveText("#Alpha");
  expect(
    await source.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
      inset: getComputedStyle(element).paddingInlineStart,
    })),
  ).toEqual(dmStyle);
  await expect(mentionRow).not.toContainText(/ · (Mention|Thread|Agent)/);
  const hierarchy = await mentionRow.evaluate((row) => {
    const sender = row.querySelector("strong");
    const source = row.querySelector("[data-inbox-source]");
    if (!sender || !source) return undefined;
    return {
      senderWeight: Number(getComputedStyle(sender).fontWeight),
      sourceSize: Number.parseFloat(getComputedStyle(source).fontSize),
      senderSize: Number.parseFloat(getComputedStyle(sender).fontSize),
      sourceFill: getComputedStyle(source).backgroundColor,
      rowFill: getComputedStyle(row).backgroundColor,
    };
  });
  expect(hierarchy?.senderWeight).toBeGreaterThanOrEqual(500);
  expect(hierarchy?.sourceSize).toBeLessThan(hierarchy?.senderSize);
  expect(hierarchy?.sourceFill).toBe("rgba(0, 0, 0, 0)");
  expect(
    await source.evaluate((element) => {
      const preview = element
        .closest(".navigation-item-label")
        .querySelector("[class*='preview']");
      return (
        preview &&
        element.getBoundingClientRect().top <
          preview.getBoundingClientRect().top
      );
    }),
  ).toBe(true);
  await chooseFilter("Threads");
  await expect(
    inbox.getByText("Unread reply 1", { exact: true }),
  ).toBeVisible();
  await chooseFilter("Mentions");
  for (const [mode, width] of [
    ["light", 1280],
    ["dark", 760],
    ["dark", 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(filter).toBeVisible();
    await expect(unread).toBeVisible();
    const toolbar = inbox.locator('[class*="toolbar"]').first();
    const layout = await toolbar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [
        ...element.querySelectorAll(
          '[aria-label="Inbox filters"], [aria-label="Unread only"]',
        ),
      ].map((control) => {
        const { left, right, top, bottom } = control.getBoundingClientRect();
        return { left, right, top, bottom };
      });
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        controls,
      };
    });
    expect(layout.controls.length).toBe(2);
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(layout.left);
      expect(control.right).toBeLessThanOrEqual(layout.right);
      expect(control.top).toBeGreaterThanOrEqual(layout.top);
      expect(control.bottom).toBeLessThanOrEqual(layout.bottom);
    }
    // The consolidated filter and Unread only remain usable when the toolbar wraps.

    const opener = mentionRow.getByRole("button", { name: /^Open / });
    const dot = opener.getByRole("img", { name: "Unread", exact: true });
    await expect(dot).toBeVisible();
    const dotLayout = await dot.evaluate((element) => {
      const button = element.closest("button");
      const label = button.querySelector(".navigation-item-label");
      const trailing = element.closest(".navigation-item-trailing");
      return {
        insideTrailing: !!trailing && button.contains(trailing),
        row: button.getBoundingClientRect().toJSON(),
        label: label.getBoundingClientRect().toJSON(),
        dot: element.getBoundingClientRect().toJSON(),
      };
    });
    expect(dotLayout.insideTrailing).toBe(true);
    expect(dotLayout.dot.left).toBeGreaterThanOrEqual(dotLayout.label.right);
    expect(dotLayout.dot.right).toBeLessThan(dotLayout.row.right);
    expect(dotLayout.dot.top).toBeGreaterThanOrEqual(dotLayout.row.top);
    expect(dotLayout.dot.bottom).toBeLessThanOrEqual(dotLayout.row.bottom);
    await expect(
      inbox.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    expect(
      await inbox.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`inbox-${mode}-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const expected = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 1");
  await mentionRow.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Enter");
  // The row opens its exact thread in a side tab; the list stays the main tab.
  const sideTabs = inbox.getByRole("tablist", { name: "Panel tabs" });
  await expect(sideTabs.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(
    sideTabs.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    inbox
      .getByRole("tablist", { name: "Inbox tabs" })
      .getByRole("tab", { name: "Inbox", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    inbox.getByRole("list", { name: "Inbox conversations" }),
  ).toBeVisible();
  const detail = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const thread = detail.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${expected.id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: "Unread reply 1" }),
  ).toBeInViewport();
  // Main owns the floating message actions/grouping. Hover must not reserve a
  // new row or displace content in this embedded consumer.
  const firstMessage = thread.locator("[data-message-id]").first();
  const beforeHover = await firstMessage.boundingBox();
  await firstMessage.hover();
  await expect
    .poll(async () => (await firstMessage.boundingBox())?.height)
    .toBe(beforeHover?.height);
  // Opening does not visit Channels; the Inbox page stays in view.
  await expect(page.getByRole("region", { name: "Channels" })).toHaveCount(0);
  await expect(mentionRow.getByRole("img", { name: "Unread" })).toHaveCount(0);
  // Narrow widths follow the shared tab layout: the open tab, its reader and
  // composer stay within the available Inbox width without overflow.
  for (const [mode, width] of [
    ["light", 720],
    ["dark", 900],
    ["dark", 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    const editor = detail.getByRole("textbox", { name: "Reply to thread" });
    const close = inbox.getByRole("button", {
      name: "Close Thread root 1 tab",
      exact: true,
    });
    const send = detail.getByRole("button", { name: "Send message" });
    const available = await inbox.boundingBox();
    for (const control of [detail, thread, editor, close, send]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(available.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        available.x + available.width,
      );
      expect(box.y + box.height).toBeLessThanOrEqual(
        available.y + available.height,
      );
    }
    expect(
      await inbox.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(
      thread.getByText("Unread reply 1", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`inbox-selected-${mode}-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(filter).toBeVisible();
  await chooseFilter("Mentions");
  // Opening reads; right-click and keyboard still expose local unread.
  const row = mentionRow;
  await expect(row.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await expect(
    row.getByRole("button", { name: /Mark as read|Mark unread/ }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark as read" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  let action = page.getByRole("menuitem", { name: "Mark unread" });
  await expect(action).toBeVisible();
  await expect(page.getByText("Mark unread on this device only.")).toHaveCount(
    0,
  );
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mark unread" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  // A re-click does not undo the user's mark; a new visit after another
  // conversation does.
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await inbox.getByRole("button", { name: "Unread only" }).click();
  await expect(rows).toHaveCount(2);
  await rows
    .filter({ hasText: "Broadcast descendant" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(sideTabs.getByRole("tab")).toHaveCount(1);
  await expect(
    sideTabs.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click();
  await expect(sideTabs.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await row.getByRole("button", { name: /^Open / }).click({ button: "right" });
  action = page.getByRole("menuitem", { name: "Mark unread" });
  await action.click();
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  // The DM timeline and composer must occupy one vertical column in its tab.
  await chooseFilter("DMs");
  await rows
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(sideTabs.getByRole("tab")).toHaveText(["Alice Fixture"]);
  const direct = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  await expect(direct.locator("header")).toHaveCount(0);
  await expect(direct.getByRole("form")).toHaveCount(1);
  await expect(
    direct.getByRole("textbox", { name: /^Message / }),
  ).toBeVisible();
  const geometry = await direct.evaluate((element) => {
    const history = element.querySelector(
      '[aria-label="Channel message history"]',
    );
    const composer = element.querySelector("form");
    if (!history || !composer) return;
    return {
      history: history.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry?.composer.top).toBeGreaterThanOrEqual(
    geometry.history.bottom,
  );
  expect(geometry?.composer.left).toBeGreaterThanOrEqual(geometry.history.left);
  expect(geometry?.composer.right).toBeLessThanOrEqual(geometry.history.right);
});

// Newest-first integration: exact Inbox selection must not be replaced by the
// newest ten replies; the saved draft context is exercised by PR5.
test.describe("signed newest-first Inbox windows", () => {
  const channel = "00000000-0000-0000-0000-000000000123";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    inboxThreadWindow: true,
    channelIds: ["alpha", channel],
    channelNames: { [channel]: "Window room" },
    historyCounts: { alpha: 1, [channel]: 0 },
  });
  test("reveals an older exact unread anchor in newest-first context", async ({
    page,
    app,
  }) => {
    const { root, replies } = app.inboxWindow;
    const oldest = replies[0],
      newest = replies.at(-1);
    await page.goto(app.origin);
    await openPage(page, "Inbox");

    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const rows = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem");
    const row = rows.filter({ hasText: "Window room" });
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", {
      name: "Conversation in Window room",
      exact: true,
    });
    const target = detail.locator(`[data-message-id="${oldest.id}"]`);
    await expect(target).toBeInViewport();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.thread_window &&
            filter.limit === 10 &&
            filter["#h"]?.includes(channel),
        ),
      )
      .toBe(true);
    await expect(
      detail.locator(`[data-message-id="${newest.id}"]`),
    ).toBeAttached();
    // The selected anchor survives a later arrival; no fresh click/reveal was requested.
    const arrival = app.reply(root.id);
    await expect(
      detail.getByText("New peer reply", { exact: true }),
    ).toBeAttached();
    await expect(target).toBeInViewport();
    // Re-clicking the selected row reveals its current message in the same tab.
    const again = rows.filter({ hasText: "Window room" });
    await expect(again).toContainText("New peer reply");
    await again.getByRole("button", { name: /^Open / }).click();
    await expect(
      inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab"),
    ).toHaveCount(1);
    const current = detail
      .locator("[data-message-id]")
      .filter({ hasText: "New peer reply" });
    await expect(current).toBeInViewport();
    await expect(current).toBeFocused();
    // This removal is signed by the synthetic author and arrives through the
    // actual shared relay stream. It cannot turn a vanished target into a tail reveal.
    app.deleteInboxAnchor(arrival);
    await expect(current).toHaveCount(0);
    // Other participating replies keep the conversation in the list, and its
    // tab stays open on the thread.
    await expect(again).toHaveCount(1);
    await expect(again).not.toContainText("New peer reply");
    await expect(
      detail.locator(`[data-message-id="${root.id}"]`),
    ).toBeAttached();
  });
});

// Solo agents answer at top level: Inbox still opens a Solo thread, read-only.
test.describe("Inbox Solo chat thread", () => {
  test.use({
    soloChannels: ["alpha"],
    agentPeers: true,
    inboxSoloAgent: true,
  });
  test("a Solo chat thread reply opens its thread without a reply composer", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const row = inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" });
    await row.getByRole("button", { name: /^Open / }).click();
    // A session's thread reply opens its thread tab, not the whole session.
    const detail = inbox.getByRole("region", { name: /^Conversation in / });
    await expect(
      inbox.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab"),
    ).toHaveCount(1);
    await expect(detail.getByText("Unread reply 1")).toBeVisible();
    await expect(
      detail.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveCount(0);
  });
});

// Browser-only: the open tab covers the list at this width. Real IndexedDB
// rejection must stay retryable above the list once its tab pane is closed.
test("narrow Inbox keeps a rejected read save and its captured Retry behind an open tab", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    window.inboxReadFailure = { armed: false, failures: 0, saves: 0 };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === "partitions" &&
        this.transaction.db.name === "buzz-read-state-v1"
      ) {
        if (
          window.inboxReadFailure.armed &&
          Object.keys(value?.state?.frontiers ?? {}).length
        ) {
          window.inboxReadFailure.failures++;
          throw new Error("Synthetic read storage failure");
        }
        this.transaction.addEventListener(
          "complete",
          () => {
            window.inboxReadFailure.saves++;
          },
          { once: true },
        );
      }
      return put.call(this, value, ...args);
    };
  });
  const base = Date.now();
  await page.clock.install({ time: base });
  await open(page, app);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await page.getByRole("button", { name: inboxName }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const filters = inbox.getByRole("button", { name: "Inbox filters" });
  await filters.click();
  await page
    .getByRole("menuitemradio", { name: "Mentions", exact: true })
    .click();
  const row = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" });
  await expect(row.getByRole("img", { name: "Unread" })).toBeVisible();
  await page.evaluate(() => {
    window.inboxReadFailure.armed = true;
  });
  // The fixed pause point is beyond this test's timeout, never runner now, so
  // reader dwell cannot save behind Retry.
  await page.clock.pauseAt(base + 180_000);
  try {
    await row.getByRole("button", { name: /^Open / }).click();
    const detail = inbox.getByRole("region", {
      name: "Conversation in Alpha",
      exact: true,
    });
    await expect(detail).toBeVisible();
    const alert = inbox
      .getByRole("alert")
      .filter({ hasText: "Synthetic read storage failure" });
    await expect(alert).toBeVisible();
    const retry = alert.getByRole("button", { name: "Retry inbox" });
    // Closing the pane uncovers the list and its Retry; the failure survives.
    await inbox
      .getByRole("button", { name: "Toggle tab pane", exact: true })
      .click();
    await expect
      .poll(async () => {
        await page.clock.runFor(16);
        return retry.click({ trial: true, timeout: 100 }).then(
          () => true,
          () => false,
        );
      })
      .toBe(true);
    await expect(retry).toBeInViewport();
    await expect(alert).toBeVisible();
    const saves = await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
      return window.inboxReadFailure.saves;
    });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.inboxReadFailure.saves))
      .toBeGreaterThan(saves);
    // Retry owned focus when its alert left, so the Show filter receives it.
    await expect(filters).toBeFocused();
    await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  } finally {
    await page.clock.resume();
    await page.evaluate(() => {
      window.inboxReadFailure.armed = false;
    });
  }
});

// Browser-only: a DM opens its whole conversation in a tab at narrow width,
// where real portalled video dismissal must stay with its document-level owner.
test("a narrow DM tab keeps portalled media dismissal inside the tab", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const videoUrl = "https://primary.example/media/inbox-review.mp4";
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: "tests/fixtures/message-gallery/assets/sample.mp4",
      contentType: "video/mp4",
    }),
  );
  app.append(
    "primary",
    "dm-peer",
    "Inbox video",
    false,
    false,
    undefined,
    undefined,
    [["imeta", `url ${videoUrl}`, "m video/mp4"]],
  );
  await inbox.getByRole("button", { name: "Inbox filters" }).click();
  await page.getByRole("menuitemradio", { name: "DMs", exact: true }).click();
  await inbox.getByRole("button", { name: "Unread only" }).click();
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const row = list.getByRole("listitem").first();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await row.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  await expect(
    detail
      .locator("[data-message-id]")
      .filter({ hasText: "Inbox DM fixture reply" }),
  ).toBeVisible();
  await expect(detail.getByRole("form")).toHaveCount(1);
  const mediaOpener = detail.getByRole("button", {
    name: "Open video fullscreen",
  });
  await detail.locator("[data-video-preview]").hover();
  await expect(mediaOpener).toHaveCSS("pointer-events", "auto");
  await mediaOpener.click();
  const media = page.getByRole("dialog", { name: "Video review" });
  await expect(media).toBeVisible();
  await media.getByRole("button", { name: "Close fullscreen viewer" }).focus();
  await page.keyboard.press("Escape");
  await expect(media).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(mediaOpener).toBeFocused();
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
});
