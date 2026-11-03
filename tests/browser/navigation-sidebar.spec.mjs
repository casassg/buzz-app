import {
  selectCommunity,
  openCommunityPicker,
  inboxName,
} from "./navigation.mjs";
import { checkDurationConsumer } from "./duration-layout.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  pageChoice,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { createServer } from "./vite-server.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Selection motion and cancellation during window resize need real CSS layout
// and animation timelines, which a DOM emulator cannot exercise.
test("segmented selections slide but window resizing follows the selected tab immediately", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/design-system.html#/design/components/tabs`,
    );
    for (const label of [
      "Segmented filters",
      "Small segmented filters",
      "Icon segmented filters",
    ]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      const list = page.getByRole("tablist", { name: label, exact: true });
      await list.getByRole("tab").first().click();
      await list.locator(".buzz-tabs-indicator").evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const capture = await list.evaluateHandle((list) => {
        const indicator = list.querySelector(".buzz-tabs-indicator");
        if (!indicator) throw new Error("Missing segmented indicator");
        const start = indicator.getBoundingClientRect().left;
        const state = {
          progress: undefined,
          resizeError: undefined,
        };
        let targetWidth;
        const observer = new MutationObserver(() => {
          const selected = list
            .querySelector('[aria-selected="true"]')
            ?.getBoundingClientRect();
          if (!selected) throw new Error("Missing selected tab");
          if (state.progress === undefined) {
            const animation = indicator
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSTransition &&
                  animation.transitionProperty === "transform",
              );
            if (!animation?.effect || selected.left === start) return;
            // Hold an actual intermediate frame, independent of runner speed.
            animation.pause();
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2;
            state.progress =
              (indicator.getBoundingClientRect().left - start) /
              (selected.left - start);
            targetWidth = selected.width;
          } else if (Math.abs(selected.width - targetWidth) > 1) {
            const pill = indicator.getBoundingClientRect();
            state.resizeError = Math.max(
              Math.abs(pill.left - selected.left),
              Math.abs(pill.right - selected.right),
            );
          }
        });
        observer.observe(indicator, {
          attributes: true,
          attributeFilter: ["style"],
        });
        return {
          state,
          dispose() {
            observer.disconnect();
            indicator.getAnimations().forEach((animation) => {
              animation.finish();
            });
          },
        };
      });
      try {
        await list.getByRole("tab").last().click();
        await expect
          .poll(() => capture.evaluate(({ state }) => state.progress))
          .toBeDefined();
        const progress = await capture.evaluate(({ state }) => state.progress);
        expect(
          progress,
          `${label} travels from its previous selection`,
        ).toBeGreaterThan(0);
        expect(
          progress,
          `${label} has not jumped to its destination`,
        ).toBeLessThan(1);
        // Window resizing must also cancel a slide already in progress.
        await page.setViewportSize({ width: 640, height: 900 });
        await expect
          .poll(() => capture.evaluate(({ state }) => state.resizeError))
          .toBeDefined();
        expect(
          await capture.evaluate(({ state }) => state.resizeError),
          label,
        ).toBeLessThan(1);
      } finally {
        await capture.evaluate(({ dispose }) => dispose());
        await capture.dispose();
      }
    }
  } finally {
    await server.close();
  }
});

test.describe("scope indicator", () => {
  test.use({ largeSidebar: false });

  // Only browser layout can compare the indicator's measured target with its
  // rendered box during resize; jsdom cannot exercise flex sizing or transitions.
  test("scope selection follows sidebar resize at normal and enlarged text", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const scope = page.getByRole("tablist", { name: "Navigation scope" });
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    const aligned = () =>
      scope.evaluate((list) => {
        const tab = list
          .querySelector('[aria-selected="true"]')
          .getBoundingClientRect();
        const pill = list
          .querySelector(".buzz-tabs-indicator")
          .getBoundingClientRect();
        return Math.max(
          Math.abs(tab.left - pill.left),
          Math.abs(tab.right - pill.right),
        );
      });

    for (const scale of [1, 2]) {
      await page.evaluate((scale) => {
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
      }, scale);
      for (const label of ["All", "Solo", "Team"]) {
        await handle.press("Home");
        await scope.getByRole("tab", { name: label, exact: true }).click();
        await expect.poll(aligned).toBeLessThan(1);
        const capture = await scope.evaluateHandle((list) => {
          const indicator = list.querySelector(".buzz-tabs-indicator");
          const initialWidth = indicator.getBoundingClientRect().width;
          const state = { sample: undefined };
          const observer = new MutationObserver(() => {
            const tab = list
              .querySelector('[aria-selected="true"]')
              .getBoundingClientRect();
            const target = Number.parseFloat(
              indicator.style.getPropertyValue("--active-tab-width"),
            );
            if (
              Math.abs(target - initialWidth) < 1 ||
              Math.abs(target - tab.width) > 1
            )
              return;
            // Read at the measurement update, before a CSS transition can settle.
            // A later retrying geometry assertion would miss resize lag entirely.
            const pill = indicator.getBoundingClientRect();
            state.sample = {
              left: Math.abs(tab.left - pill.left),
              right: Math.abs(tab.right - pill.right),
            };
            observer.disconnect();
          });
          observer.observe(indicator, {
            attributes: true,
            attributeFilter: ["style"],
          });
          return { state, dispose: () => observer.disconnect() };
        });
        try {
          const grip = await handle.boundingBox();
          await page.mouse.move(
            grip.x + grip.width / 2,
            grip.y + grip.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(
            grip.x + grip.width / 2 + 180,
            grip.y + grip.height / 2,
          );
          await expect
            .poll(() => capture.evaluate(({ state }) => state.sample))
            .toBeDefined();
          const sample = await capture.evaluate(({ state }) => state.sample);
          expect(
            sample.left,
            `${label} left edge at ${scale * 100}%`,
          ).toBeLessThan(1);
          expect(
            sample.right,
            `${label} right edge at ${scale * 100}%`,
          ).toBeLessThan(1);
        } finally {
          await page.mouse.up();
          await capture.evaluate(({ dispose }) => dispose());
          await capture.dispose();
        }
        await expect(
          scope.getByRole("tab", { name: label, exact: true }),
        ).toHaveAttribute("aria-selected", "true");
      }
    }
  });
});

test("channel sidebar resizes from the full gutter and persists", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebarPanel = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const sidebar = page.locator(".shell-sidebar").filter({ has: sidebarPanel });
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  const channelList = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const before = await sidebar.boundingBox();
  const grip = await handle.boundingBox();
  const listBox = await channelList.boundingBox();
  expect(before).not.toBeNull();
  expect(grip).not.toBeNull();
  expect(listBox).not.toBeNull();
  const geometry = await sidebarPanel.evaluate((panel) => {
    const content = panel.firstElementChild;
    const row = panel.querySelector('[data-channel-id="alpha"]');
    if (!(content instanceof HTMLElement) || !(row instanceof HTMLElement))
      throw new Error("Sidebar geometry is unavailable");
    const handle = document.querySelector('[aria-label="Resize sidebar"]');
    if (!(handle instanceof HTMLElement))
      throw new Error("Missing sidebar gutter");
    const contentStyle = getComputedStyle(content);
    const rowStyle = getComputedStyle(row);
    const rootSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return {
      panelGap: Number.parseFloat(
        getComputedStyle(panel.closest(".shell-sidebar")).marginInlineEnd,
      ),
      panelGapToken:
        Number.parseFloat(contentStyle.getPropertyValue("--space-panel-gap")) *
        rootSize,
      // The redesigned sidebar keeps a symmetric inline gutter; rows use the
      // sidebar's fixed row radius rather than a concentric panel radius.
      padding: [contentStyle.paddingRight, contentStyle.paddingLeft].map(
        Number.parseFloat,
      ),
      rowRadius: Number.parseFloat(rowStyle.borderTopLeftRadius),
      // Custom properties retain rem units; computed corner values are pixels.
      rowRadiusToken:
        Number.parseFloat(contentStyle.getPropertyValue("--radius-row")) *
        rootSize,
    };
  });
  expect(new Set(geometry.padding).size).toBe(1);
  expect(geometry.padding[0]).toBeGreaterThan(0);
  expect(geometry.rowRadius).toBe(geometry.rowRadiusToken);
  const conversation = await page
    .locator("#main-content > .panel")
    .boundingBox();
  expect(geometry.panelGap).toBe(geometry.panelGapToken);
  expect(conversation).not.toBeNull();
  expect(conversation.x - (before.x + before.width)).toBeCloseTo(
    geometry.panelGap,
    0,
  );
  expect(grip.x + grip.width / 2).toBeCloseTo(
    before.x + before.width + geometry.panelGap / 2,
    0,
  );
  expect(grip.width).toBeGreaterThanOrEqual(16);
  expect(grip.height).toBeGreaterThan(500);
  // Preserve the 2px scrollbar inset plus the panel’s reserved 1px border.
  expect(before.x + before.width - (listBox.x + listBox.width)).toBeCloseTo(
    3,
    0,
  );
  await expect(handle).not.toHaveAttribute("title");
  await expect(button(page, "Alpha")).not.toHaveAttribute("title");
  await expect(handle).toHaveAttribute(
    "data-tooltip",
    "Drag to resize · Double-click to reset",
  );
  const tooltip = () =>
    handle.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return {
        delay: style.transitionDelay,
        opacity: style.opacity,
        visibility: style.visibility,
      };
    });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  // Hover must resolve to the resize target across the grip and both gutter edges.
  expect(
    await handle.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [1, bounds.width / 2, bounds.width - 1].map((offset) => {
        const hit = document.elementFromPoint(
          bounds.left + offset,
          bounds.top + bounds.height / 2,
        );
        return hit === element && getComputedStyle(hit).cursor === "ew-resize";
      });
    }),
  ).toEqual([true, true, true]);
  await expect.poll(async () => (await tooltip()).delay).toBe("0.6s");
  await expect.poll(tooltip).toMatchObject({
    opacity: "1",
    visibility: "visible",
  });

  await handle.press("ArrowRight");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(before.width);
  const keyboardWidth = (await sidebar.boundingBox()).width;
  const movedGrip = await handle.boundingBox();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2,
    movedGrip.y + movedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    movedGrip.x + movedGrip.width / 2 + 120,
    movedGrip.y + movedGrip.height / 2,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hovered = document.querySelector(":hover");
        return hovered ? getComputedStyle(hovered).cursor : undefined;
      }),
    )
    .toBe("ew-resize");
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeGreaterThan(keyboardWidth + 100);
  const resized = await sidebar.boundingBox();
  await openPage(page, "Workflows");
  await openPage(page, "Messages");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(resized.width, 0);

  await handle.dblclick();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(260, 0);

  await handle.press("Home");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(220, 0);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  const wideViewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: wideViewport.height });
  const constrained = await sidebar.boundingBox();
  expect(constrained.width).toBeLessThan(520);
  await expect(handle).toHaveAttribute(
    "aria-valuenow",
    String(Math.round(constrained.width)),
  );

  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(520, 0);
  await page.setViewportSize({ width: 800, height: wideViewport.height });
  await handle.press("ArrowLeft");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 8);
  await handle.press("End");
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(constrained.width, 0);
  const constrainedGrip = await handle.boundingBox();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    constrainedGrip.x + constrainedGrip.width / 2 - 32,
    constrainedGrip.y + constrainedGrip.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeLessThan(constrained.width - 24);
  const explicitlyResized = await sidebar.boundingBox();
  await page.setViewportSize(wideViewport);
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(explicitlyResized.width, 0);
});

// Channel creation needs a connection that can write 9007.
const creationSidebar = test.extend({ channelWriteKinds: [9, 9007, 30315] });
creationSidebar(
  "Channels opens the shared creation dialog",
  async ({ page, app }, testInfo) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect(page.locator('[data-channel-id="alpha"]')).toBeVisible();

    await openPage(page, "Workflows");
    await expect(
      page.getByRole("heading", { name: "Workflows", exact: true }),
    ).toBeVisible();
    const channels = page
      .getByRole("navigation", { name: "Subscribed channels" })
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
    const summary = channels.locator("summary");
    const create = page.getByRole("button", { name: "Create channel" });
    const createContainer = create.locator("..");
    await expect(createContainer).toHaveCSS("opacity", "0");
    await summary.hover();
    await expect(createContainer).toHaveCSS("opacity", "1");
    await expect(create).toHaveAttribute("data-icon-shape", "control");
    const [summaryBox, createBox] = await Promise.all([
      summary.boundingBox(),
      create.boundingBox(),
    ]);
    expect(summaryBox.x + summaryBox.width).toBeCloseTo(
      createBox.x + createBox.width + 4,
      0,
    );
    await create.click();

    const dialog = page.getByRole("dialog", { name: "Create a channel" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
    await dialog.getByRole("radio", { name: /Temporary/ }).click();
    await checkDurationConsumer(page, dialog, "create-duration", testInfo);
    await expect(
      dialog.getByRole("radio", { name: /Temporary/ }),
    ).toBeChecked();
    await dialog
      .getByRole("button", { name: "Close channel creation" })
      .click();
    await page
      .getByRole("dialog", { name: "Discard changes?" })
      .getByRole("button", { name: "Discard changes" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(create).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Workflows", exact: true }),
    ).toBeVisible();
    await openPage(page, "Messages");
    const conversation = page.getByRole("article", { name: "Conversation" });
    await conversation.click({ position: { x: 20, y: 20 } });
    await expect(create).not.toBeFocused();
    await expect(createContainer).toHaveCSS("opacity", "0");
  },
);

test("hovering a sidebar row inks only that row, not its siblings", async ({
  page,
  app,
}) => {
  await open(page, app);
  // Buzzin' light is where hover ink differs from resting navigation ink.
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "light";
    document.documentElement.dataset.colorLevel = "high";
  });
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const inbox = pages.getByRole("button", { name: inboxName });
  // The fixture registers one sidebar page; real communities list several
  // as siblings in this list. Add an inert sibling row with the same markup.
  const sibling = pages.locator("[data-sibling-probe]");
  const [hoverInk, restInk] = await inbox.evaluate((row) => {
    const copy = row.cloneNode(true);
    copy.setAttribute("data-sibling-probe", "");
    copy.setAttribute("tabindex", "-1");
    copy.setAttribute("aria-hidden", "true");
    row.after(copy);
    const probe = (color) => {
      const span = document.createElement("span");
      span.style.color = color;
      row.append(span);
      const value = getComputedStyle(span).color;
      span.remove();
      return value;
    };
    return [probe("var(--text-row)"), probe("var(--text-navigation)")];
  });
  expect(hoverInk).not.toBe(restInk);
  // Rows transition into the new level's ink; settle before hovering.
  await expect(inbox).toHaveCSS("color", restInk);
  await expect(sibling).toHaveCSS("color", restInk);
  await inbox.hover();
  await expect(inbox).toHaveCSS("color", hoverInk);
  await expect(sibling).toHaveCSS("color", restInk);
});

test("channel navigation preserves sidebar DOM and group state", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const node = await sidebar.elementHandle();
  await button(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(group).not.toHaveAttribute("open");
});

test("navigation reveals the current sidebar entry without moving a visible one", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const scrollTop = () => sidebar.evaluate((element) => element.scrollTop);
  const toBottom = () =>
    sidebar.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
  const alpha = sidebar.locator('[data-channel-id="alpha"]');
  const projects = page
    .getByRole("navigation", { name: "Topbar pages" })
    .getByRole("tab", { name: "Workflows", exact: true });
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await expect(alpha).toHaveAttribute("aria-current", "page");
  expect(await toBottom()).toBeGreaterThan(100);
  await expect(alpha).not.toBeInViewport();
  // Search navigation reveals a page entry.
  await openPage(page, "Workflows");
  await expect(projects).toHaveAttribute("aria-selected", "true");
  await expect(projects).toBeInViewport({ ratio: 1 });
  // History navigation reveals a channel row.
  await toBottom();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(alpha).toBeInViewport({ ratio: 1 });
  // An already visible entry keeps the user's scroll position.
  const settled = await scrollTop();
  await button(page, "Beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  expect(await scrollTop()).toBe(settled);
  // A destination without its own entry leaves the list alone; leaving it
  // still reveals the entry the user scrolled away from.
  await sidebar
    .locator("summary")
    .filter({ hasText: /^Direct messages$/ })
    .hover();
  await sidebar
    .getByRole("button", { name: "New message", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "New message", exact: true }),
  ).toBeVisible();
  const composing = await toBottom();
  expect(await scrollTop()).toBe(composing);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator('[data-channel-id="beta"]')).toBeInViewport({
    ratio: 1,
  });
  // A collapsed section reveals its header and stays collapsed.
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await toBottom();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(group).not.toHaveAttribute("open");
  await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
});

// The closed narrow drawer is display: none, and opening it does not
// rerender the sidebar, so a reveal that waited for layout must retry then.
test("a reveal while the narrow drawer is closed runs when the drawer opens", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.setViewportSize({ width: 600, height: 700 });
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  // Role queries skip the hidden drawer; this locator does not.
  const alpha = page.locator(
    'nav[aria-label="Subscribed channels"] [data-channel-id="alpha"]',
  );
  await openPage(page, "Workflows");
  await button(page, "Show navigation").click();
  await expect(sidebar).toBeVisible();
  const bottom = await sidebar.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(bottom).toBeGreaterThan(100);
  await button(page, "Hide navigation").click();
  await expect(sidebar).toBeHidden();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await button(page, "Show navigation").click();
  await expect(alpha).toBeInViewport({ ratio: 1 });
});

for (const destination of ["Workflows", "Settings", "Back/Forward"]) {
  test(`sidebar state survives Messages → ${destination} → Messages`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const group = sidebar
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
    const node = await sidebar.elementHandle();
    const toBottom = () =>
      sidebar.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });
    const pageEntry = (name) =>
      ["Inbox", "Bestie"].includes(name)
        ? page
            .getByRole("navigation", { name: "Pages" })
            .getByRole("button", { name, exact: true })
        : page
            .getByRole("navigation", { name: "Topbar pages" })
            .getByRole("tab", { name, exact: true });
    const leave = async () => {
      if (destination === "Settings") {
        await openSettings(page);
      } else {
        await openPage(
          page,
          destination === "Back/Forward" ? "Workflows" : destination,
        );
      }
      if (destination === "Settings") {
        // The Settings modal retains the sidebar behind it, hidden from
        // assistive technology and inert until Settings closes.
        await expect(sidebar).toHaveCount(0);
        expect(
          await node.evaluate(
            (element) =>
              element.isConnected &&
              !!element.closest('[aria-hidden="true"], [inert]'),
          ),
        ).toBe(true);
      } else {
        await expect(sidebar).toBeVisible();
        expect(await node.evaluate((element) => element.isConnected)).toBe(
          true,
        );
        await expect(
          pageEntry(destination === "Back/Forward" ? "Workflows" : destination),
        ).toBeInViewport({ ratio: 1 });
        await toBottom();
      }
      await expect(
        page.getByRole("region", { name: "Channel message history" }),
      ).toHaveCount(0);
      if (destination === "Back/Forward") await button(page, "Go back").click();
      else if (destination === "Settings") await closeSettings(page);
      else await openPage(page, "Messages");
    };
    await group.locator("summary").click();
    await expect(group).not.toHaveAttribute("open");
    const scroll = await toBottom();
    expect(scroll).toBeGreaterThan(100);
    await leave();
    await expect(group).not.toHaveAttribute("open");
    if (destination === "Settings")
      // Settings retains the sidebar; returning to the same channel keeps
      // the saved position instead of revealing it again.
      await expect
        .poll(() => sidebar.evaluate((element) => element.scrollTop))
        .toBeCloseTo(scroll, 0);
    // The current channel is in the collapsed group; its header shows it.
    else await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
    if (destination === "Back/Forward") {
      await button(page, "Go forward").click();
      await expect(sidebar).toBeVisible();
      expect(await node.evaluate((element) => element.isConnected)).toBe(true);
      await expect(
        page.getByRole("region", { name: "Channel message history" }),
      ).toHaveCount(0);
      await expect(pageEntry("Workflows")).toBeInViewport({ ratio: 1 });
      await toBottom();
      await button(page, "Go back").click();
      await expect(group).not.toHaveAttribute("open");
      await expect(group.locator("summary")).toBeInViewport({ ratio: 1 });
    }
  });
}

test("community picker stays available across pages and restores focus after joining", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", {
    name: "Communities",
    exact: true,
  });
  await expect(
    rail.getByRole("button", {
      name: "Community switcher: Primary",
      exact: true,
    }),
  ).toBeVisible();
  await selectCommunity(page, "Secondary");
  await openPage(page, "Workflows");
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Switch community", exact: true }),
  ).toHaveCount(0);
  await selectCommunity(page, "Personal space");
  await (await openCommunityPicker(page))
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Join a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    rail.getByRole("button", {
      name: "Community switcher: Personal space",
      exact: true,
    }),
  ).toBeFocused();
});

test("sidebar view state does not leak across communities", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await selectCommunity(page, "Secondary");
  await expect(button(page, "Community switcher: Secondary")).toBeVisible();
  await expect(group).toHaveAttribute("open");
  await selectCommunity(page, "Primary");
  await expect(group).not.toHaveAttribute("open");
});

test("invalid saved sidebar fields fall back", async ({ page, app }) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const group = sidebar.locator("details").first();
  await group.locator("summary").click();
  await selectCommunity(page, "Secondary");
  await expect(button(page, "Community switcher: Secondary")).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.includes('"channel-sidebar"'),
    );
    if (!key)
      throw new Error("Sidebar state was not saved on leaving its session");
    localStorage.setItem(
      key,
      JSON.stringify({
        collapsed: [null, 42],
        scrollTop: -100,
        width: "wide",
      }),
    );
  });
  await selectCommunity(page, "Primary");
  await expect(button(page, "Community switcher: Primary")).toBeVisible();
  await expect(button(page, "Beta")).toBeVisible();
  await expect(sidebar.locator("details").first()).toHaveAttribute("open");
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("rail loads relay-owned image icons for inactive communities without acquiring sessions", async ({
  page,
  app,
}) => {
  const rasterIcon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y79d4sAAAAASUVORK5CYII=";
  const emojiSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ffe75c"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🐝</text></svg>';
  const emojiIcon = `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`;
  const infoRequests = [];
  await page.route("**/api/relay/*/icon-info", (route) => {
    infoRequests.push(route.request().url());
    const icon = route.request().url().includes("primary")
      ? rasterIcon
      : emojiIcon;
    return route.fulfill({ json: { icon } });
  });
  await open(page, app);
  const rail = await openCommunityPicker(page);
  for (const [name, icon] of [
    ["Primary", rasterIcon],
    ["Secondary", emojiIcon],
  ]) {
    const image = rail
      .getByRole("button", { name: `Switch to ${name}` })
      .locator("img");
    await expect(image).toHaveAttribute("src", icon);
    await expect(image).toHaveAttribute("data-loaded", "true");
  }
  expect(infoRequests).toHaveLength(2);
  expect(app.report.sessions).toEqual(["primary"]);
});

// Same-page navigation must update the remembered selection without a remount.
test("Messages reselects the latest sidebar channel and keyboard page search focuses main", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Beta").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await button(page, "Search Buzz").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const search = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(search).toBeFocused();
  await search.pressSequentially("Messages");
  await expect(pageChoice(dialog, "Messages")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await search.press("Enter");
  await expect(composer).toBeVisible();
  await expect(page.locator('button[data-channel-id="beta"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#main-content")).toBeFocused();
});
