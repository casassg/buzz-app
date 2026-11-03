import { readFileSync } from "node:fs";
import { inboxName } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import {
  activate,
  expectAnchor,
  open,
  settle,
  upper,
  virtuaIdle,
} from "./timeline.mjs";

import { wheel } from "./timeline.mjs";

const closeRequest = `{ const tabEvent = "buzz:close-active-tab";\n${readFileSync(
  new URL("../../src-tauri/src/close-request.js", import.meta.url),
  "utf8",
)}\n}`;

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 20 },
});

test("Back restores each thread visit before the previous channel", async ({
  page,
  app,
}) => {
  const beta = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator('button[data-channel-id="beta"]');
  // Intent preparation can supply the same badge as the held unread batch.
  // Gate both sources; focus explicitly instead of relying on roster warming.
  let releaseHead;
  let sawHead;
  const headHeld = new Promise((resolve) => {
    releaseHead = resolve;
  });
  const headStarted = new Promise((resolve) => {
    sawHead = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.top_level && filter["#h"]?.includes("beta"))
    ) {
      sawHead();
      await headHeld;
    }
    await route.continue().catch(() => {});
  });
  app.relay.holdUnread();
  try {
    await open(page, app);
    await beta.focus(); // Prepare without selecting or adding a navigation visit.
    await headStarted;
    await expect.poll(() => app.report.unreadHolds.length).toBe(1);
    await expect(beta).toHaveAccessibleName("Beta");
  } finally {
    releaseHead();
    app.relay.releaseUnread();
  }
  // Unread evidence changes the accessible name independently of navigation.
  await expect(beta.getByRole("img")).toHaveAccessibleName(
    "20 observed unread messages. Not an exact total.",
  );
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const threadButton = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });

  await activate(threadButton(roots[0]));
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await activate(threadButton(roots[1]));
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const openThread = await panel
    .getByRole("region", { name: "Thread messages", exact: true })
    .elementHandle();
  // A real browser proves the host loads and paints repeat-open feedback,
  // then delivers animationend. The lower-layer tests own the state matrix.
  const selectedTab = page.locator(
    `[role="tab"][data-tab-value="thread:alpha:${roots[1].id}"]`,
  );
  const feedback = await selectedTab.evaluateHandle((tab) => {
    const state = { cue: null, paint: null };
    const start = (event) => {
      if (!event.target.classList.contains("buzz-tabs-attention")) return;
      tab.removeEventListener("animationstart", start);
      state.cue = event.target;
      for (const animation of state.cue.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      // Read the paint now. A slow renderer can deliver animationstart and
      // animationend together, and the host removes the cue on animationend.
      state.paint = {
        tint: getComputedStyle(state.cue).backgroundColor,
        resting: getComputedStyle(state.cue.parentElement).backgroundColor,
        opacity: Number(getComputedStyle(state.cue).opacity),
      };
    };
    tab.addEventListener("animationstart", start);
    return state;
  });
  await activate(threadButton(roots[1]));
  try {
    await expect
      .poll(() => feedback.evaluate((state) => !!state.paint))
      .toBe(true);
    const paint = await feedback.evaluate(({ paint }) => paint);
    expect(paint.tint).not.toBe(paint.resting);
    expect(paint.opacity).toBeGreaterThan(0);
  } finally {
    await feedback.evaluate(({ cue }) => {
      for (const animation of cue?.getAnimations() ?? []) animation.finish();
    });
    await feedback.dispose();
  }
  await expect(selectedTab.locator(".buzz-tabs-attention")).toHaveCount(0);
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  expect(await openThread.evaluate((node) => node.isConnected)).toBe(true);
  await beta.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  // Back switches to the earlier thread's tab; the later one stays open.
  const laterThread = await panel.elementHandle();
  await page.goBack();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  expect(await laterThread.evaluate((node) => node.isConnected)).toBe(true);
});

for (const reading of [false, true]) {
  test(`ordinary reply-count opening ${reading ? "preserves intervening reading" : "finishes at the bottom"} after held pagination`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    let last;
    for (let i = 0; i < 120; i++) last = app.reply(root.id, false, false);
    await open(page, app);
    const region = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    const routePattern = "**/api/relay/**/query";
    await page.route(routePattern, async (route) => {
      if (
        !requested &&
        route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter.depth_limit && filter.thread_cursor !== undefined,
          )
      ) {
        requested = true;
        await held;
      }
      await route.continue();
    });
    try {
      const trigger = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      // Virtua can retain its pointer lock after geometry stops moving. Wait
      // for input readiness before Playwright tries alternate scroll alignments.
      await virtuaIdle(page);
      await trigger.click();
      await expect.poll(() => requested).toBe(true);
      // One of the 50 loaded replies is a collapsed descendant.
      await expect(region.locator("[data-message-id]")).toHaveCount(50);
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toHaveCount(0);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      // The panel is presented even while bounded history is still pending.
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      await expect(region).toHaveAttribute("aria-busy", "false");
      await expect
        .poll(() =>
          region.evaluate(
            (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
          ),
        )
        .toBeLessThan(4);
      let position = 0;
      if (reading) {
        const bottom = await region.evaluate((node) => node.scrollTop);
        await region.hover();
        // A wheel request is not an exact displacement (Linux WebKit can stop
        // short), so the reading position is wherever the completed gesture
        // came to rest; the checks below then hold that value exactly.
        await wheel(page, -500, region);
        position = await region.evaluate((node) => node.scrollTop);
        expect(position, "reading gesture leaves the bottom").toBeLessThan(
          bottom,
        );
      }
      release();
      await expect(region.locator("[data-message-id]")).toHaveCount(123);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("Jump to latest");
      } else {
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        await expect(
          region.locator(`[data-message-id="${last.id}"]`),
        ).toBeInViewport();
        await expect(
          page.getByRole("textbox", { name: "Reply to thread", exact: true }),
        ).toBeFocused();
      }
      const live = app.reply(root.id);
      await expect(
        region.locator(`[data-message-id="${live.id}"]`),
      ).toBeVisible();
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
        const jumpToLatest = region.locator("button[data-jump-to-latest]");
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Space");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(1);
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("inert", "");
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("aria-hidden", "true");
        await expect(region.getByRole("button").and(jumpToLatest)).toHaveCount(
          0,
        );
        await expect(jumpToLatest).toBeHidden();
        await region.hover();
        await wheel(page, -500, region);
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeGreaterThan(80);
        const nextLive = app.reply(root.id);
        await expect(jumpToLatest).toHaveAccessibleName("1 new message");
        await jumpToLatest.focus();
        await page.keyboard.press("Enter");
        await expect(region).toBeFocused();
        await expect(
          region.locator(`[data-message-id="${nextLive.id}"]`),
        ).toBeInViewport();
        await expect(jumpToLatest).toHaveCount(1);
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("inert", "");
        await expect(
          jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
        ).toHaveAttribute("aria-hidden", "true");
        await expect(region.getByRole("button").and(jumpToLatest)).toHaveCount(
          0,
        );
        await expect(jumpToLatest).toBeHidden();
      } else {
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
      }
      // Expansion changes visibility, not the loaded-history count.
      await region.getByRole("button", { name: /^View 1 reply/ }).click();
      await expect(
        region.getByText("Broadcast descendant", { exact: true }),
      ).toBeInViewport();
      await expect(region.locator("[data-message-id]")).toHaveCount(
        reading ? 126 : 125,
      );
    } finally {
      release();
      await page.unroute(routePattern);
    }
  });
}

// Browser-only: native focus steps keep a caret already inside the editing
// root, and inert tab panes are real layout; jsdom models neither.
test("choosing a thread tab resumes typing where its reply was left", async ({
  page,
  app,
}) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  for (const [index, root] of roots.slice(0, 2).entries()) {
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(
      panel.getByText(`Thread root ${index}`, { exact: true }),
    ).toBeVisible();
  }
  const reply = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const workspace = page.locator("[data-panel-workspace]");
  const selected = workspace.locator(
    '[role="tab"][data-tab-value^="thread:"][aria-selected="true"]',
  );
  const tabValue = await selected.getAttribute("data-tab-value");
  await reply.click();
  await page.keyboard.type("here is a message");
  await expect(reply).toHaveText("here is a message");
  // Move the native caret without notifying ProseMirror, reproducing a pending
  // selectionchange when a tab click takes focus. Set the selection directly
  // so setup does not depend on delivery of fifteen separate caret key events.
  await reply.evaluate((editor) => {
    window.holdSelectionChange = true;
    document.addEventListener(
      "selectionchange",
      (event) => {
        if (window.holdSelectionChange) event.stopImmediatePropagation();
      },
      { capture: true },
    );
    const text = document
      .createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      .nextNode();
    if (!text) throw new Error("Reply text is missing");
    document.getSelection().collapse(text, 2);
  });
  // Establish the native caret boundary before focus leaves; the deliberately
  // blocked selectionchange still cannot update ProseMirror for us.
  await expect
    .poll(() =>
      reply.evaluate((editor) => {
        const selection = editor.ownerDocument.getSelection();
        return selection?.focusNode && editor.contains(selection.focusNode)
          ? selection.focusOffset
          : -1;
      }),
    )
    .toBe(2);
  await workspace
    .locator('[role="tab"][data-tab-value^="thread:"][aria-selected="false"]')
    .click();
  await page.evaluate(() => {
    window.holdSelectionChange = false;
  });
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("");
  await workspace.locator(`[role="tab"][data-tab-value="${tabValue}"]`).click();
  await expect(reply).toBeFocused();
  await page.keyboard.type("X");
  await expect(reply).toHaveText("heXre is a message");

  // Keyboard selection stays in the tab list.
  await selected.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(selected).toBeFocused();
});

// Real pointer capture, hit testing and retained editor DOM are browser-only.
test("dragging thread tabs reorders and crosses panes without losing the reply", async ({
  page,
  app,
}) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  for (const root of roots.slice(0, 2)) {
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(
      page.getByRole("complementary", { name: "Thread", exact: true }),
    ).toBeVisible();
  }
  const side = page.locator("[data-panel-workspace]");
  const main = page.locator("[data-main-workspace]");
  const threadTabs = (host) =>
    host.locator('[role="tab"][data-tab-value^="thread:"]');
  const ids = await threadTabs(side).evaluateAll((tabs) =>
    tabs.map((tab) => tab.dataset.tabValue),
  );
  const moving = () => page.locator(`[role="tab"][data-tab-value="${ids[1]}"]`);
  const reply = page
    .getByRole("complementary", { name: "Thread", exact: true })
    .getByRole("textbox", { name: "Reply to thread", exact: true });
  await reply.fill("Keep this reply");
  const retained = await reply.elementHandle();
  async function begin() {
    const box = await moving().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  const first = await threadTabs(side).first().boundingBox();
  await begin();
  await page.mouse.move(first.x + 2, first.y + first.height / 2, { steps: 8 });
  await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
  await expect(threadTabs(side)).toHaveCount(2); // no changes before release
  await page.mouse.up();
  await expect
    .poll(() =>
      threadTabs(side).evaluateAll((tabs) =>
        tabs.map((tab) => tab.dataset.tabValue),
      ),
    )
    .toEqual([ids[1], ids[0]]);

  // The empty header beyond the compact tab strip accepts a transfer too.
  const header = await main.locator("header").first().boundingBox();
  await begin();
  await page.mouse.move(
    header.x + header.width / 2,
    header.y + header.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
  await page.mouse.up();
  await expect(threadTabs(main)).toHaveCount(1);
  await expect(threadTabs(side)).toHaveCount(1);
  expect(await retained.evaluate((editor) => editor.isConnected)).toBe(true);
  await expect(
    main.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveText("Keep this reply");

  const destination = await threadTabs(side).first().boundingBox();
  await begin();
  await page.mouse.move(
    destination.x + 2,
    destination.y + destination.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".buzz-tab-drag-insertion")).toHaveCount(0);
  await page.mouse.up();
  await expect(threadTabs(main)).toHaveCount(1);
  await expect(
    main.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveText("Keep this reply");

  // With the side pane closed there is no header to drop onto. Separating
  // at the main workspace's right edge reveals it without creating a blank tab.
  await side
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  await expect(side).toBeHidden();
  const bounds = await main.boundingBox();
  const closedHeader = await main.locator("header").first().boundingBox();
  await begin();
  // Even near the right edge, the full header remains an insertion target.
  await page.mouse.move(
    bounds.x + bounds.width - 4,
    closedHeader.y + closedHeader.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
  await expect(page.locator(".buzz-tab-drag-edge")).toHaveCount(0);
  await page.mouse.move(
    bounds.x + bounds.width - 110,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".buzz-tab-drag-edge")).toBeVisible();
  await expect(side).toBeHidden();
  await page.mouse.up();
  await expect(side).toBeVisible();
  await expect(threadTabs(main)).toHaveCount(0);
  await expect(threadTabs(side)).toHaveCount(2);
  await expect(
    side.getByRole("tab", { name: "New tab", exact: true }),
  ).toHaveCount(0);
  await expect(
    side.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveText("Keep this reply");
  expect(await retained.evaluate((editor) => editor.isConnected)).toBe(true);

  // Moving the last side tab away also removes the pane, without toggling it.
  for (let remaining = 2; remaining > 0; remaining--) {
    const moved = await threadTabs(side).first().getAttribute("data-tab-value");
    await threadTabs(side).first().focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect(threadTabs(side)).toHaveCount(remaining - 1);
    // Placement commits before moveBy's animation-frame focus handoff. Finish
    // that handoff before focusing another tab for the next shortcut.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(
      main.locator(`[role="tab"][data-tab-value="${moved}"]`),
    ).toBeFocused();
  }
  await expect(side).toBeHidden();
  const emptyBounds = await main.boundingBox();
  await begin();
  await page.mouse.move(
    emptyBounds.x + emptyBounds.width - 4,
    emptyBounds.y + emptyBounds.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".buzz-tab-drag-edge")).toBeVisible();
  await page.mouse.up();
  await expect(side).toBeVisible();
  await expect(threadTabs(side)).toHaveCount(1);
  await expect(
    side.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveText("Keep this reply");
});

// Native frontmost hit testing and pointer capture across history navigation
// cannot be established in jsdom. Keep both regressions on actual pane wiring.
for (const scenario of ["narrow overlay", "same-channel history"]) {
  test(`thread dragging respects ${scenario}`, async ({ page, app }) => {
    await open(page, app);
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const side = page.locator("[data-panel-workspace]");
    const main = page.locator("[data-main-workspace]");
    const tabs = (host) =>
      host.locator('[role="tab"][data-tab-value^="thread:"]');
    for (const root of roots.slice(0, 2)) {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect(
        side.getByRole("complementary", { name: "Thread", exact: true }),
      ).toBeVisible();
    }
    const ids = await tabs(side).evaluateAll((rows) =>
      rows.map((row) => row.dataset.tabValue),
    );
    if (scenario === "narrow overlay") {
      await page.setViewportSize({ width: 800, height: 700 });
      // Establish the overlay, not just a small viewport that might stack panes.
      await expect
        .poll(async () => {
          const a = await main.boundingBox(),
            b = await side.boundingBox();
          return !!a && !!b && b.x < a.x + a.width && a.y < b.y + b.height;
        })
        .toBe(true);
    }
    const source = await tabs(side).nth(1).boundingBox();
    const destination = await tabs(side).first().boundingBox();
    await page.mouse.move(
      source.x + source.width / 2,
      source.y + source.height / 2,
    );
    await page.mouse.down();
    try {
      await page.mouse.move(
        destination.x + 2,
        destination.y + destination.height / 2,
        { steps: 8 },
      );
      await expect(page.locator(".buzz-tab-drag-insertion")).toBeVisible();
      if (scenario === "same-channel history") {
        await page.goBack();
        await expect(
          side
            .getByRole("complementary", { name: "Thread", exact: true })
            .getByText("Thread root 0", { exact: true }),
        ).toBeVisible();
        await expect(page.locator(".buzz-tab-drag-insertion")).toHaveCount(0);
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-tab-dragging",
          "",
        );
      }
    } finally {
      await page.mouse.up();
    }
    await expect(tabs(main)).toHaveCount(0);
    await expect
      .poll(() =>
        tabs(side).evaluateAll((rows) =>
          rows.map((row) => row.dataset.tabValue),
        ),
      )
      .toEqual(scenario === "narrow overlay" ? [ids[1], ids[0]] : ids);
    if (scenario === "same-channel history") {
      await expect(
        side.locator('[role="tab"][aria-selected="true"]'),
      ).toHaveAttribute("data-tab-value", ids[0]);
    }
  });
}

// Paint and actual viewport intersection cannot be established in jsdom.
test("closing an active thread highlights its visible channel origin without scrolling", async ({
  page,
  app,
}) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const timeline = page.locator('[data-channel-timeline="alpha"]');
  const item = timeline.locator(`[data-message-id="${roots[0].id}"]`);
  const origin = item.locator(":scope > [data-layout]");
  // Keep another side tab open so closing does not change the channel width
  // and rewrap the history independently of the highlight.
  await timeline
    .locator(`[data-message-id="${roots[1].id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  await item.getByRole("button", { name: /^View thread:/ }).click();
  const side = page.locator("[data-panel-workspace]");
  await expect(
    side.locator('[role="tab"][data-tab-value^="thread:"]'),
  ).toHaveCount(2);
  await virtuaIdle(page, timeline);
  const scroll = await timeline.evaluate((element) => element.scrollTop);
  // Observe paint admission before triggering close; the cue is transient.
  await origin.evaluate((element) => {
    // The cue paints on the row's filled bubble, or on the row without one.
    window.arrivalCue = (row) =>
      [row, ...row.querySelectorAll('[class*="messageBubble"]')]
        .map((painted) => getComputedStyle(painted, "::after").animationName)
        .find((name) => name !== "none") ?? "none";
    window.returnHighlightPainted = false;
    const observer = new MutationObserver(() => {
      if (window.arrivalCue(element).includes("message-highlight")) {
        window.returnHighlightPainted = true;
        observer.disconnect();
      }
    });
    observer.observe(element, { attributes: true, attributeFilter: ["class"] });
  });
  await side
    .locator(
      '.buzz-tabs-item:has([role="tab"][aria-selected="true"]) > button:not([role="tab"])',
    )
    .click();
  await expect
    .poll(() => page.evaluate(() => window.returnHighlightPainted))
    .toBe(true);
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollTop))
    .toBe(scroll);
  await expect
    .poll(() => origin.evaluate((element) => window.arrivalCue(element)))
    .toBe("none");
});

// Real retained main-pane selection/focus order differs from DOM-emulator steps.
test("closing a main-pane thread with Escape returns keyboard focus to its opener", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-thread-placement.v1", "main"),
  );
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const trigger = page
    .locator(`[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ });
  await trigger.focus();
  await trigger.press("Enter");
  const main = page.locator("[data-main-workspace]");
  const editor = main.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(
    main.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(trigger).toBeFocused();
});

// Native Close follows real focus across both workspaces, and the page's
// opener return runs after the tab host's own focus recovery.
test("consecutive native Close requests close each side thread, then return focus to its opener", async ({
  page,
  app,
}) => {
  await open(page, app);
  const triggers = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"))
    .map((root) =>
      page
        .locator(
          `[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`,
        )
        .getByRole("button", { name: /^View thread:/ }),
    );
  for (const trigger of triggers) await activate(trigger);
  const side = page.locator("[data-panel-workspace]");
  const threads = side.locator('[role="tab"][data-tab-value^="thread:"]');
  await expect(threads).toHaveCount(2);
  await side
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .focus();
  const close = () => page.evaluate(closeRequest);
  expect(await close()).toBe("handled");
  await expect(threads).toHaveCount(1);
  await expect(
    side.locator('[role="tab"][aria-selected="true"]'),
  ).toBeFocused();
  expect(await close()).toBe("handled");
  await expect(threads).toHaveCount(0);
  await expect(triggers.at(-1)).toBeFocused();
  // With no tab left, Close does nothing and keeps the window.
  expect(await close()).toBe("unhandled");
});

// Closing the addressed thread also starts a channel history visit; only the
// real navigation and visit wiring shows whether it keeps the remaining tab.
test("consecutive native Close requests close each main-pane thread, then return focus to its opener", async ({
  page,
  app,
}) => {
  await open(page, app);
  const triggers = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"))
    .map((root) =>
      page
        .locator(
          `[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`,
        )
        .getByRole("button", { name: /^View thread:/ }),
    );
  for (const trigger of triggers) await activate(trigger);
  const side = page.locator("[data-panel-workspace]");
  const main = page.locator("[data-main-workspace]");
  const threads = (host) =>
    host.locator('[role="tab"][data-tab-value^="thread:"]');
  await expect(threads(side)).toHaveCount(2);
  for (const count of [1, 2]) {
    await threads(side).first().focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect(threads(main)).toHaveCount(count);
  }
  await main
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .focus();
  const close = () => page.evaluate(closeRequest);
  expect(await close()).toBe("handled");
  await expect(threads(main)).toHaveCount(1);
  const selected = main.locator('[role="tab"][aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-tab-value", /^thread:/);
  await expect(selected).toBeFocused();
  expect(await close()).toBe("handled");
  await expect(threads(main)).toHaveCount(0);
  await expect(triggers.at(-1)).toBeFocused();
  expect(await close()).toBe("unhandled");
});

// A linked thread's opener lives in another tab of the same pane; real
// inert panes and focus order decide whether closing returns to the link.
for (const how of ["native Close", "the close button"]) {
  test(`closing a linked thread with ${how} returns focus to its link in the side pane`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const [target] = app.histories.get("primary/beta");
    const reply = app.append(
      "primary",
      "alpha",
      `Side link <buzz://message?channel=beta&id=${target.id}>.`,
      true,
      true,
      root.id,
    );
    await page
      .locator(`[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const side = page.locator("[data-panel-workspace]");
    const threads = side.locator('[role="tab"][data-tab-value^="thread:"]');
    await expect(threads).toHaveCount(1);
    const link = side
      .locator(`[data-message-id="${reply.id}"]`)
      .getByRole("link", { name: "Alice Fixture in #Beta", exact: true });
    await expect(link).toBeVisible();
    await virtuaIdle(page);
    await link.click({ button: "right" });
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Open link", exact: true })
      .click();
    await expect(threads).toHaveCount(2);
    const linked = side.locator('[role="tab"][data-tab-value^="thread:beta:"]');
    await expect(linked).toHaveAttribute("aria-selected", "true");
    if (how === "native Close")
      expect(await page.evaluate(closeRequest)).toBe("handled");
    else
      await side
        .locator(
          '.buzz-tabs-item:has([data-tab-value^="thread:beta:"]) > button:not([role="tab"])',
        )
        .click();
    await expect(threads).toHaveCount(1);
    await expect(link).toBeFocused();
  });
}

// Header openings reset a retained main-pane thread selection after mount;
// only real layout-effect order shows whether that steals the tab's focus.
test("header openings keep focus while a main-pane thread is retained", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-thread-placement.v1", "main"),
  );
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const main = page.locator("[data-main-workspace]");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  const messages = topbar.getByRole("tab", {
    name: "Messages",
    exact: true,
  });
  const projects = topbar.getByRole("tab", { name: "Workflows", exact: true });
  const inbox = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: inboxName });
  for (const leave of [inbox, projects]) {
    await page
      .locator(`[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    await expect(
      main.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    await leave.click();
    await messages.focus();
    await messages.press("Enter");
    await expect(
      main.getByRole("tab", { name: "Alpha", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await messages.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await expect(messages).toBeFocused();
  }
});

// A malformed root hint crosses real navigation/reader/store/portal wiring;
// only the verified message ancestry may replace selection, never an old editor.
test("a wrong link hint preserves both open thread editors and selects the verified destination", async ({
  page,
  app,
}) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Broadcast reply");
  const threadButton = (root) =>
    page
      .locator(`[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const side = page.locator("[data-panel-workspace]");
  const main = page.locator("[data-main-workspace]");
  const reply = (host) =>
    host.getByRole("textbox", { name: "Reply to thread", exact: true });
  await activate(threadButton(roots[0]));
  await reply(side).fill("Destination draft");
  const destinationEditor = await reply(side).elementHandle();
  await activate(threadButton(roots[1]));
  await reply(side).fill("Keep original draft");
  const originalEditor = await reply(side).elementHandle();
  await side.locator('[role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(reply(main)).toHaveText("Keep original draft");
  const linked = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${target.id}&thread=${roots[1].id}>.`,
  );
  await main.getByRole("tab", { name: "Alpha", exact: true }).click();
  await page
    .locator(`[data-channel-timeline="alpha"] [data-message-id="${linked.id}"]`)
    .getByRole("link", { name: "Alice Fixture in #Alpha", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  await expect(
    side.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect(reply(side)).toHaveText("Destination draft");
  await expect(
    main.locator('[role="tab"][data-tab-value^="thread:"]'),
  ).toHaveCount(1);
  expect(await originalEditor.evaluate((el) => el.isConnected)).toBe(true);
  expect(await destinationEditor.evaluate((el) => el.isConnected)).toBe(true);
  await main.locator('[role="tab"][data-tab-value^="thread:"]').click();
  await expect(reply(main)).toHaveText("Keep original draft");
});

test.describe(() => {
  test.use({ historyCounts: { alpha: 80, beta: 20 } });

  // A covered tab skips layout, so it misses resizes and arrivals while hidden.
  // Revealing it must still restore the reading position, not a stale one.
  test("a covered conversation keeps its reading position through a resize and a new message", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("buzz-thread-placement.v1", "main"),
    );
    await open(page, app);
    const main = page.locator("[data-main-workspace]");
    const conversation = main.getByRole("tab", { name: "Alpha", exact: true });
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    await activate(
      page
        .locator(
          `[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`,
        )
        .getByRole("button", { name: /^View thread:/ }),
    );
    const reply = main.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reply).toBeVisible();
    const thread = main.locator(
      `[role="tab"][data-tab-value="thread:alpha:${root.id}"]`,
    );
    await expect(thread).toHaveAttribute("aria-selected", "true");
    // The main pane pushes threads across the conversation; let it land.
    const motion = main.locator("[data-entering], [data-leaving]");
    await expect(motion).toHaveCount(0);
    await conversation.click();
    await expect(motion).toHaveCount(0);
    await settle(page);
    const saved = await upper(page);
    await thread.click();
    await expect(reply).toBeVisible();
    await expect(motion).toHaveCount(0);
    const covered = page.locator(
      `[id="${await conversation.getAttribute("aria-controls")}"]`,
    );
    await expect(covered).toHaveAttribute("data-covered", "true");
    await expect
      .poll(() =>
        covered.evaluate(
          (element) => getComputedStyle(element).contentVisibility,
        ),
      )
      .toBe("hidden");
    await page.setViewportSize({ width: 1100, height: 760 });
    const arrival = app.append("primary", "alpha", "Arrived while covered");
    // The covered timeline receives it without being shown.
    // Covered content has no accessible name; its text still updates.
    await expect(covered.locator("button[data-jump-to-latest]")).toHaveText(
      "1 new message",
    );
    await conversation.click();
    await expect(conversation).toHaveAttribute("aria-selected", "true");
    // A pointer reveal hands focus to the tab's composer, as before.
    await expect(
      main.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeFocused();
    await expect(motion).toHaveCount(0);
    await settle(page);
    await expectAnchor(page, saved);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await expect(
      history.locator("button[data-jump-to-latest]"),
    ).toHaveAccessibleName("1 new message");
    await expect(
      history.locator(`[data-message-id="${arrival.id}"]`),
    ).not.toBeInViewport();
  });
});

// Browser-only: real popstate traversal remounts a thread tab left in another
// channel, and its reading place is real scroll geometry; jsdom models neither.
test("Back and Forward return to a root-linked thread's reading place; a fresh link reveals it again", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  for (let i = 0; i < 40; i++)
    app.append(
      "primary",
      "alpha",
      `Long reply ${i}\n${"Enough text to scroll the thread. ".repeat(8)}`,
      false,
      false,
      root.id,
    );
  const betaRoot = app.append("primary", "beta", "Beta root", false, false);
  const betaReply = app.append(
    "primary",
    "beta",
    "Beta reply",
    false,
    false,
    betaRoot.id,
  );
  // No thread hint: the link names the root, so its opening reveals it.
  // Thread-row links would reach the fixture's catch-all panel; these
  // timeline links take the same navigation.
  const opener = app.append(
    "primary",
    "alpha",
    `Start at <buzz://message?channel=alpha&id=${root.id}>, then <buzz://message?channel=beta&id=${betaReply.id}&thread=${betaRoot.id}>`,
    false,
  );
  await open(page, app);
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const region = panel.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const links = page.locator(
    `[data-channel-timeline] [data-message-id="${opener.id}"]`,
  );
  const rootLink = links.getByRole("link", {
    name: "Fixture Reader in #Alpha",
    exact: true,
  });
  const opened = () =>
    expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
  const rootAtTop = () =>
    expect
      .poll(() =>
        region.evaluate(
          (node, id) =>
            node
              .querySelector(`[data-message-id="${id}"]`)
              .getBoundingClientRect().top - node.getBoundingClientRect().top,
          root.id,
        ),
      )
      .toBeLessThan(4);
  const gap = () =>
    region.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
  const place = () =>
    region.evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      const row = [...node.querySelectorAll("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top + 1,
      );
      return {
        id: row.dataset.messageId,
        y: Math.round(row.getBoundingClientRect().top - top),
      };
    });
  const expectPlace = (saved) =>
    expect
      .poll(async () => {
        const now = await place();
        return now.id === saved.id && Math.abs(now.y - saved.y) < 4;
      })
      .toBe(true);
  // Sample each frame from before a traversal until stopped, recording the
  // place of every one that shows this thread's rows.
  const sampleFrames = () =>
    page.evaluate((id) => {
      const frames = [];
      window.threadFrames = frames;
      const sample = () => {
        if (window.threadFrames !== frames) return;
        const node = [
          ...document.querySelectorAll('[aria-label="Thread messages"]'),
        ].find((node) => node.querySelector(`[data-message-id="${id}"]`));
        if (node && !node.hasAttribute("data-positioning")) {
          const top = node.getBoundingClientRect().top;
          const row = [...node.querySelectorAll("[data-message-id]")].find(
            (row) => row.getBoundingClientRect().bottom > top + 1,
          );
          frames.push({
            id: row?.dataset.messageId,
            y: Math.round((row?.getBoundingClientRect().top ?? top) - top),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, root.id);
  const sampledFrames = () =>
    page.evaluate(() => {
      const frames = window.threadFrames;
      window.threadFrames = undefined;
      return frames;
    });

  await rootLink.click();
  await opened();
  await rootAtTop();
  await settle(page, region);
  await region.hover();
  for (let i = 0; i < 12 && (await gap()) >= 4; i++)
    await wheel(page, 4000, region);
  expect(await gap()).toBeLessThan(4);
  await links
    .getByRole("link", { name: "Alice Fixture in #Beta", exact: true })
    .click();
  await expect(panel.getByText("Beta reply", { exact: true })).toBeVisible();

  // Back remounts the thread where it was left: the end, not the root.
  await page.goBack();
  await expect(region.locator(`[data-message-id="${root.id}"]`)).toHaveCount(1);
  await opened();
  await settle(page, region);
  expect(await gap()).toBeLessThan(4);

  // A place within the thread survives Forward then Back.
  await region.hover();
  await wheel(page, -1500, region);
  expect(await gap()).toBeGreaterThan(400);
  expect(await region.evaluate((node) => node.scrollTop)).toBeGreaterThan(400);
  const saved = await place();
  await page.goForward();
  await expect(panel.getByText("Beta reply", { exact: true })).toBeVisible();
  await opened();
  // The remounted thread stays hidden until its route restores the place:
  // no frame shows the bottom it positions at first.
  await sampleFrames();
  await page.goBack();
  await expect(region.locator(`[data-message-id="${root.id}"]`)).toHaveCount(1);
  await opened();
  await settle(page, region);
  await expectPlace(saved);
  const frames = await sampledFrames();
  expect(frames.length).toBeGreaterThan(0);
  expect(
    frames.filter(
      (frame) => frame.id !== saved.id || Math.abs(frame.y - saved.y) >= 4,
    ),
  ).toEqual([]);

  // Forward into the visit from its own channel keeps the mounted place too.
  await page.goBack();
  await opened();
  await page.goForward();
  await opened();
  await settle(page, region);
  await expectPlace(saved);

  // Following the link again is a new opening: it reveals the root.
  await rootLink.click();
  await opened();
  await rootAtTop();
});
