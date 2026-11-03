import {
  closeSettings,
  openPage,
  openSettings,
  selectCommunity,
  settingsSections,
  settleShellToggle,
  inboxName,
} from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";

import { open, wheel } from "./timeline.mjs";

// These layout/navigation journeys exercise the opt-in Bestie surface.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const key = "buzzodz.plugins.v1";
    if (localStorage.getItem(key) === null)
      localStorage.setItem(
        key,
        JSON.stringify({ version: 2, enabled: { "buzz.bestie": true } }),
      );
  });
});

test.use({ savedSidebar: true });

test("sidebar scrollbar stays close to the divider without clipping its native thumb", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 360 });
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollHeight > viewport.clientHeight,
      ),
    )
    .toBe(true);
  // Without a saved position, startup reveals the current entry.
  await expect(sidebar.locator('[aria-current="page"]').first()).toBeInViewport(
    { ratio: 1 },
  );
  const geometry = await sidebar.evaluate((viewport) => {
    const frame = viewport.parentElement;
    if (!(frame instanceof HTMLElement))
      throw new Error("Missing sidebar frame");
    const panel = viewport.closest('[aria-label="Sidebar"]');
    const bounds = viewport.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    return {
      rightInset: panelBounds.right - bounds.right,
      clipped: bounds.right > frame.getBoundingClientRect().right,
      paddingTop: Number.parseFloat(getComputedStyle(viewport).paddingTop),
    };
  });
  expect(geometry).toEqual({
    rightInset: 3,
    clipped: false,
    paddingTop: 8,
  });
});

// Real layout, pointer hover and portaled-menu geometry cannot be proven in jsdom.
// Keep this fixture small; the existing sidebar-unread journeys own overflow scale.
test("compact sidenav keeps its geometry across persistent page navigation", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.getByRole("button", { name: "Alpha", exact: true });
  const panel = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const pages = panel.getByRole("navigation", { name: "Pages" });
  const destinations = ["Inbox", "Bestie"].map((name) =>
    pages.getByRole("button", { name, exact: true }),
  );
  const assertDestinationFillParity = async () => {
    const geometry = await Promise.all(
      destinations.map((destination) =>
        destination.evaluate((element) => {
          const panel = element.closest('aside[aria-label="Sidebar"]');
          if (!(panel instanceof HTMLElement))
            throw new Error("Missing channel sidebar panel");
          const panelRect = panel.getBoundingClientRect();
          const rowRect = element.getBoundingClientRect();
          return {
            left: rowRect.left - panelRect.left,
            right: panelRect.right - rowRect.right,
          };
        }),
      ),
    );
    for (const row of geometry) {
      expect(row.left).toBe(13);
      expect(row.right).toBe(row.left);
    }
  };
  await assertDestinationFillParity();
  const before = await alpha.boundingBox();
  expect(before.height).toBe(28);
  const viewportBox = await sidebar.boundingBox();
  const alphaBox = await alpha.boundingBox();
  const overflow = await sidebar.evaluate((viewport) => ({
    clientWidth: viewport.clientWidth,
    scrollWidth: viewport.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  expect(alphaBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(alphaBox.x + alphaBox.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  const assertRowFillRounded = async () => {
    const visual = await alpha.evaluate((button) => {
      const row = button.closest("[data-channel-sidebar-row]");
      const viewport = button.closest("nav");
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement))
        throw new Error("Missing sidebar row geometry");
      const fillStyle = getComputedStyle(row, "::before");
      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
      const contentRight = viewportRect.right - scrollbarWidth;
      return {
        fillInset:
          contentRight - (rowRect.right - Number.parseFloat(fillStyle.right)),
        leftContentInset: rowRect.left - viewportRect.left,
        rightContentInset: contentRight - rowRect.right,
        radius: fillStyle.borderTopRightRadius,
        overflow: rowStyle.overflow,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollbarWidth,
      };
    });
    expect(visual.scrollbarWidth).toBe(visual.offsetWidth - visual.clientWidth);
    expect(visual.leftContentInset).toBe(0);
    expect(visual.rightContentInset).toBe(0);
    expect(visual.fillInset).toBe(10);
    expect(Number.parseFloat(visual.radius)).toBeGreaterThan(0);
    expect(visual.overflow).toBe("visible");
  };
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "220px";
  });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollWidth - viewport.clientWidth,
      ),
    )
    .toBe(0);
  const narrowViewport = await sidebar.boundingBox();
  const narrowAlpha = await alpha.boundingBox();
  await assertDestinationFillParity();
  expect(narrowAlpha.x + narrowAlpha.width).toBeLessThanOrEqual(
    narrowViewport.x + narrowViewport.width,
  );
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "260px";
  });
  await expect
    .poll(() => alpha.evaluate((row) => row.getBoundingClientRect().width))
    .toBe(before.width);
  await alpha.hover();
  await expect(
    sidebar.getByRole("button", { name: "More options for Alpha" }),
  ).toHaveCount(0);
  const afterHover = await alpha.boundingBox();
  expect(afterHover.height).toBe(before.height);
  expect(afterHover.width).toBe(before.width);
  await alpha.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  const node = await sidebar.elementHandle();
  await page
    .getByRole("navigation", { name: "Topbar pages", exact: true })
    .getByRole("tab", { name: "Agents", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Agents", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await sidebar.screenshot({ path: info.outputPath(`sidenav-${mode}.png`) });
  }
  await selectCommunity(page, "Personal space");
  // Plugin pages do not need a community, so personal space keeps them enabled.
  for (const destination of destinations)
    await expect(destination).toBeEnabled();
});

// Browser layout and native disclosure behavior are not represented in jsdom.
test("section disclosure toggles content and honors reduced motion", async ({
  page,
  app,
}) => {
  await open(page, app);
  const summary = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  const section = summary.locator("xpath=ancestor::*[@data-sidebar-section]");
  const contentId = await summary.getAttribute("aria-controls");
  expect(contentId).toBeTruthy();
  const content = section.locator(`[id="${contentId}"]`);
  const details = section.locator(":scope > div:first-child > details");
  const expanded = await section.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  for (const opening of [false, true]) {
    await summary.click();
    if (opening) await expect(details).toHaveAttribute("open", "");
    else await expect(details).not.toHaveAttribute("open");
    if (opening) await expect(content).not.toHaveAttribute("inert");
    else await expect(content).toHaveAttribute("inert", "");
    await expect
      .poll(() => section.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(opening ? expanded : 32);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await summary.click();
  await expect(details).not.toHaveAttribute("open");
  const durations = await section.evaluate((el) => {
    const content = el.querySelector(":scope > div:last-child");
    const chevron = el.querySelector("summary > span:last-child");
    return [content, chevron].map(
      (element) => getComputedStyle(element).transitionDuration,
    );
  });
  expect(durations).toEqual(["0s", "0s"]);
  expect(
    await section.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(32);
});

// Header pages swap for the overflow menu at narrow widths.
test("top bar swaps its pages for an overflow menu when narrow", async ({
  page,
  app,
}) => {
  await open(page, app);
  const header = page.locator(".shell-header");
  await expect(header).toBeVisible();
  const search = header.getByRole("button", {
    name: "Search Buzz",
    exact: true,
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const overflow = header.locator("[data-shell-pages-overflow]");
    const topbarPages = header.getByRole("navigation", {
      name: "Topbar pages",
      includeHidden: true,
    });
    if (width === 390) {
      await expect(overflow).toBeVisible();
      await expect(topbarPages).toBeHidden();
    } else {
      await expect(overflow).toBeHidden();
      await expect(topbarPages).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await search.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await expect(
    dialog.getByRole("combobox", { name: "Search Buzz" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(search).toBeFocused();
  await openPage(page, "Bestie");
  await expect(page.getByRole("region", { name: "Bestie" })).toBeVisible();
});

// Real responsive layout owns the Settings modal and the desktop sidebar.
// Settings has its own navigation; the shell sidebar toggle and its collapsed
// state stay mounted behind it, inert, and work again on close.
test("Settings retains the sidebar toggle across desktop and narrow layouts", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await openSettings(page);
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const toggle = page.locator("[data-shell-sidebar-toggle]");
  const inert = () =>
    toggle.evaluate(
      (element) => !!element.closest('[aria-hidden="true"], [inert]'),
    );
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-label", "Show sidebar");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await inert()).toBe(true);
  await expect(settingsSections(page)).toBeInViewport();
  await closeSettings(page);
  await expect(toggle).toHaveAccessibleName("Show sidebar");
  await expect(sidebar).not.toBeVisible();
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = await toggle.boundingBox();
  expect([box.width, box.height]).toEqual([32, 32]);
  await toggle.click();
  await expect(sidebar).not.toBeVisible();

  await page.setViewportSize({ width: 600, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show navigation");
  // Narrow Settings stacks its own navigation; the drawer toggle stays inert.
  await openSettings(page);
  await expect(settingsSections(page)).toBeInViewport();
  await expect(toggle).toHaveAttribute("aria-label", "Show navigation");
  expect(await inert()).toBe(true);
  await closeSettings(page);
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAccessibleName("Hide navigation");
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(sidebar).not.toBeVisible();
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show sidebar");
  await toggle.click();
  await expect(sidebar).toBeVisible();
});

// The shell owns sidebar visibility while the mounted sidebar owns route and width state.
test("shell toggle restores the shared sidebar for Channels and Agents", async ({
  page,
  app,
}) => {
  await open(page, app);
  const rail = page.getByRole("navigation", { name: "Communities" });
  const shellNavigation = page.locator("#shell-navigation");
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  // Pseudo-element help must paint outside the wrapper for pointer and keyboard.
  for (const activate of [
    () => handle.hover(),
    async () => {
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await handle.focus();
    },
  ]) {
    await activate();
    await expect
      .poll(() =>
        handle.evaluate((node) => {
          const help = getComputedStyle(node, "::before");
          return [help.visibility, help.opacity];
        }),
      )
      .toEqual(["visible", "1"]);
    const help = await handle.evaluate((node) => {
      const style = getComputedStyle(node, "::before");
      const rect = node.getBoundingClientRect();
      const wrapper = node.closest("#shell-navigation");
      return {
        content: style.content,
        right: rect.left + parseFloat(style.left) + parseFloat(style.width),
        wrapperRight: wrapper.getBoundingClientRect().right,
        clip: getComputedStyle(wrapper).clipPath,
        overflow: getComputedStyle(wrapper).overflow,
      };
    });
    expect(help.content).toContain("Drag to resize");
    expect(help.right).toBeGreaterThan(help.wrapperRight);
    expect(help.clip).toBe("none");
    expect(help.overflow).toBe("visible");
  }
  const sidebarNode = await sidebar.elementHandle();
  const panelGap = await shellNavigation.evaluate(
    (node) =>
      Number.parseFloat(
        getComputedStyle(node).getPropertyValue("--space-panel-gap"),
      ) *
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  let expandedWidth;
  for (const viewportWidth of [1440, 800]) {
    if (viewportWidth === 800) await handle.press("End");
    await page.setViewportSize({ width: viewportWidth, height: 950 });
    expandedWidth = await sidebar.evaluate(
      (node) => node.closest(".shell-sidebar").getBoundingClientRect().width,
    );
    const gutterWidth = await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.getBoundingClientRect().width +
        Number.parseFloat(style.marginLeft) +
        Number.parseFloat(style.marginRight)
      );
    });
    const track = await shellNavigation.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        width: node.getBoundingClientRect().width,
        property: style.transitionProperty,
        duration: style.transitionDuration,
      };
    });
    expect(track.width).toBe(expandedWidth + gutterWidth + panelGap);
    expect(track.property).toContain("grid-template-columns");
    expect(parseFloat(track.duration)).toBeGreaterThan(0);
    const openGap = await page.evaluate(() => {
      const sidebar = document.querySelector(".shell-sidebar");
      const main = document.querySelector("#main-content");
      if (!(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement))
        throw new Error("Missing shell panels");
      return (
        main.getBoundingClientRect().left -
        sidebar.getBoundingClientRect().right
      );
    });
    expect(openGap).toBe(gutterWidth + panelGap);
    // Seek paused real transitions so runner speed cannot hide an immediate jump.
    // Pause them when the toggle commits, before any frame: transitionrun arrives
    // in a later frame, and a stalled WebKit frame can finish the 220ms transition
    // first. Only the track and the sidebar it holds are seeked; the resize help's
    // own descendant transitions are unrelated.
    for (const label of ["Hide sidebar", "Show sidebar"]) {
      const samples = await page.evaluate(async (label) => {
        const nav = document.querySelector("#shell-navigation");
        const sidebar = nav.querySelector(".shell-sidebar");
        const button = document.querySelector(`button[aria-label="${label}"]`);
        const committed = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            // getAnimations() flushes style, so the toggle's transitions exist.
            const transitions = [
              ...nav.getAnimations(),
              ...sidebar.getAnimations(),
            ];
            for (const transition of transitions) transition.pause();
            resolve(transitions);
          });
          observer.observe(nav, {
            attributes: true,
            attributeFilter: ["aria-hidden"],
          });
        });
        button.click();
        const transitions = await committed;
        try {
          const properties = transitions.map(
            (transition) => transition.transitionProperty,
          );
          for (const property of ["grid-template-columns", "clip-path"])
            if (!properties.includes(property))
              throw new Error(`Missing ${property} transition`);
          return [0, 0.1, 0.25, 0.5, 0.75, 1].map((progress) => {
            for (const transition of transitions)
              transition.currentTime =
                transition.effect.getTiming().duration * progress;
            return {
              width: nav.getBoundingClientRect().width,
              sidebar: sidebar.getBoundingClientRect().width,
              clip: getComputedStyle(nav).clipPath,
              visibility: getComputedStyle(nav).visibility,
              trailingGap:
                nav.getBoundingClientRect().right -
                sidebar.getBoundingClientRect().right,
            };
          });
        } finally {
          for (const transition of transitions) transition.finish();
          await Promise.all(
            transitions.map((transition) => transition.finished),
          );
        }
      }, label);
      const width = expandedWidth + gutterWidth + panelGap;
      const hiding = label.startsWith("Hide");
      // The track leaves its real extent on the first sampled step and crosses
      // the midpoint halfway through, instead of stalling behind a larger
      // ceiling; the full-width panel slides with the track so its rounded
      // trailing edge stays intact instead of being cropped square.
      expect(samples[0].width).toBe(hiding ? width : 0);
      expect(samples[1].width).toBeGreaterThan(0);
      expect(samples[1].width).toBeLessThan(width);
      expect(Math.abs(samples[3].width - width / 2)).toBeLessThan(1);
      for (let index = 1; index < samples.length; index++) {
        const step = samples[index].width - samples[index - 1].width;
        expect(hiding ? -step : step).toBeGreaterThan(0);
      }
      expect(samples.at(-1).width).toBe(hiding ? 0 : width);
      for (const sample of samples) {
        expect(sample.sidebar).toBe(expandedWidth);
        expect(sample.trailingGap).toBeCloseTo(gutterWidth + panelGap, 1);
      }
      for (const sample of samples.slice(1, -1)) {
        expect(sample.clip).toBe("inset(-8px 0px -8px -8px)");
        expect(sample.visibility).toBe("visible");
      }
      expect(samples.at(-1).clip).toBe(
        hiding ? "inset(-8px 0px -8px -8px)" : "none",
      );
      expect(samples.at(-1).visibility).toBe(hiding ? "hidden" : "visible");
    }

    if (viewportWidth === 800) {
      expect(expandedWidth).toBeGreaterThan(220);
      expect(expandedWidth).toBeLessThan(520);
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (node) => node.closest(".shell-sidebar").getBoundingClientRect().width,
      ),
    )
    .toBe(520);
  expandedWidth = 520;
  const gutterWidth = await handle.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().width +
      Number.parseFloat(style.marginLeft) +
      Number.parseFloat(style.marginRight)
    );
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      shellNavigation.evaluate(
        (node) => getComputedStyle(node).transitionDuration,
      ),
    )
    .toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect
    .poll(() =>
      shellNavigation.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(expandedWidth + gutterWidth + panelGap);

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(shellNavigation).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nav = document.querySelector("#shell-navigation");
        const main = document.querySelector("#main-content");
        if (!(nav instanceof HTMLElement) || !(main instanceof HTMLElement))
          throw new Error("Missing shell panels");
        return (
          main.getBoundingClientRect().left - nav.getBoundingClientRect().right
        );
      }),
    )
    .toBe(0);
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(shellNavigation).not.toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect
    .poll(() =>
      sidebar.evaluate(
        (element) =>
          element.closest(".shell-sidebar").getBoundingClientRect().width,
      ),
    )
    .toBe(expandedWidth);

  await page
    .getByRole("navigation", { name: "Topbar pages", exact: true })
    .getByRole("tab", { name: "Agents", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Agents", exact: true }),
  ).toBeVisible();

  // Portalled comboboxes temporarily hide outside regions from assistive tech.
  // That accessibility state must not override the shell's visible layout state.
  const accessibilityHiddenWidth = await shellNavigation.evaluate(
    async (node) => {
      node.setAttribute("aria-hidden", "true");
      const transitions = node.getAnimations();
      for (const transition of transitions) transition.finish();
      await Promise.all(transitions.map((transition) => transition.finished));
      return node.getBoundingClientRect().width;
    },
  );
  await expect(shellNavigation).toHaveAttribute("data-sidebar-open", "true");
  expect(accessibilityHiddenWidth).toBe(expandedWidth + gutterWidth + panelGap);
  await shellNavigation.evaluate((node) => node.removeAttribute("aria-hidden"));

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(sidebar).not.toBeVisible();
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agents", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect
    .poll(() =>
      sidebar.evaluate(
        (element) =>
          element.closest(".shell-sidebar").getBoundingClientRect().width,
      ),
    )
    .toBe(expandedWidth);
  await expect(
    page
      .getByRole("navigation", { name: "Topbar pages", exact: true })
      .getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

// A real grid/overlay measurement is needed: DOM presence misses implicit columns.
// Inbox and Bestie leave companion placement to the shell frame, unlike Messages.
test.extend({ companionFixture: true })(
  "Inbox and Bestie pages retain companion layout across navigation and resize",
  async ({ page, app }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    const pages = page
      .getByRole("complementary", { name: "Sidebar", exact: true })
      .getByRole("navigation", { name: "Pages" });
    const launcher = page.locator(
      '.shell-header button[aria-label="Companion fixture"]',
    );
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const checkGeometry = async (body, overlay) => {
      await expect(companion).toBeVisible();
      await expect
        .poll(async () => {
          const card = await companion.boundingBox();
          const bounds = await body.boundingBox();
          if (!card || !bounds) return false;
          return overlay
            ? Math.abs(card.x + card.width - bounds.x - bounds.width) < 2 &&
                card.x < bounds.x + bounds.width
            : card.x >= bounds.x + bounds.width;
        })
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(page.viewportSize().width);
    };
    const showNavigation = async () => {
      // Inbox/Bestie have no collapsible sidebar toggle at wide widths.
      if (page.viewportSize().width <= 650) await settleShellToggle(page);
      const show = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      if (await show.isVisible()) await show.click();
    };
    const selectChannel = async (name) => {
      await showNavigation();
      await sidebar.getByRole("button", { name, exact: true }).click();
    };
    const openPage = async (name) => {
      await showNavigation();
      await pages.getByRole("button", { name, exact: true }).click();
      const body = page.getByRole("region", { name, exact: true });
      await expect(
        name === "Inbox"
          ? body.getByRole("button", { name: "Inbox filters", exact: true })
          : body.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      return body;
    };
    for (const width of [1440, 900, 600]) {
      await page.setViewportSize({ width, height: 950 });
      let body = await openPage("Inbox");
      await launcher.click();
      await checkGeometry(body, width <= 1000);
      body = await openPage("Bestie");
      await checkGeometry(body, width <= 1000);
      await launcher.click();
      await expect(companion).not.toBeVisible();
      await selectChannel("Alpha");
      await launcher.click();
      body = await openPage("Inbox");
      await checkGeometry(body, width <= 1000);
      await launcher.click();
    }
  },
);

// Real text layout: a rename changes scrollWidth without resizing the label box.
test("channel name fades follow renames without resizing the sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.locator('button[data-channel-id="alpha"]');
  const label = alpha.getByText("Alpha", { exact: true });
  const labelNode = await label.elementHandle();
  const originalWidth = await label.evaluate((element) => element.clientWidth);
  const sidebarWidth = (await sidebar.boundingBox()).width;
  await expect(label).not.toHaveAttribute("data-overflowing");
  await openChannelDetails(page);
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await settings.getByText("Diagnostics", { exact: true }).click();
  for (const [name, overflow] of [
    [
      "A very long renamed channel that cannot possibly fit in this fixed width sidebar",
      true,
    ],
    ["Alpha", false],
  ]) {
    app.renameChannel("alpha", name);
    await settings
      .getByRole("button", { name: "Refresh channels", exact: true })
      .click();
    const renamed = alpha.getByText(name, { exact: true });
    await expect(renamed).toBeVisible();
    expect(await labelNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await renamed.evaluate((element) => element.clientWidth)).toBe(
      originalWidth,
    );
    expect((await sidebar.boundingBox()).width).toBe(sidebarWidth);
    expect(
      await renamed.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(overflow);
    if (overflow)
      await expect(renamed).toHaveAttribute("data-overflowing", "true");
    else await expect(renamed).not.toHaveAttribute("data-overflowing");
  }
});

// Wheel scrolling and clipping in a short viewport require a real layout engine.
test("non-ready sidebar keeps page rows and Retry reachable by pointer scrolling", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 220 });
  await page.route("**/session", (route) => route.fulfill({ json: {} }));
  await page.goto(app.origin);
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const retry = sidebar.getByRole("button", {
    name: "Try again",
    exact: true,
  });
  await expect(retry).toBeAttached();
  const scroller = sidebar.locator('[class*="_channelList_"]');
  const scrollToBottom = async (target) => {
    await scroller.hover();
    // Visibility is not input completion: focusing early interrupts WebKit's
    // smooth wheel at a visible-but-not-fully-scrolled Retry button. The shared
    // helper observes scrollend before dispatch; an already-reached edge needs
    // no gesture (and would emit no scrollend).
    if (
      await scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop > 1,
      )
    )
      await wheel(page, 800, scroller);
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(async () => {
        const bounds = await sidebar.boundingBox();
        const row = await target.boundingBox();
        return (
          !!bounds &&
          !!row &&
          row.y >= bounds.y &&
          row.y + row.height <= bounds.y + bounds.height
        );
      })
      .toBe(true);
  };
  const expectUnclippedFocus = async (button) => {
    await page.keyboard.press("Tab");
    await button.focus();
    await expect(button).toBeFocused();
    await expect
      .poll(() =>
        button.evaluate((element) => {
          const style = getComputedStyle(element);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          let scroll = element.parentElement;
          while (scroll && getComputedStyle(scroll).overflowY !== "auto")
            scroll = scroll.parentElement;
          scroll ??= element.closest('[aria-label="Sidebar"]');
          if (!scroll || style.outlineStyle === "none" || extent <= 0)
            return false;
          const row = element.getBoundingClientRect();
          const clip = scroll.getBoundingClientRect();
          return (
            row.left - extent >= clip.left &&
            row.right + extent <= clip.left + scroll.clientWidth
          );
        }),
      )
      .toBe(true);
  };
  const expectRingAboveScrollEnd = () =>
    expect
      .poll(() =>
        retry.evaluate((element) => {
          const style = getComputedStyle(element);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          return (
            element.getBoundingClientRect().bottom + extent <=
            element.parentElement.getBoundingClientRect().bottom
          );
        }),
      )
      .toBe(true);
  await scrollToBottom(retry);
  await expectUnclippedFocus(retry);
  await expectRingAboveScrollEnd();
  // Content height can be fractional while scroll offsets snap to whole
  // pixels; hosted WebKit clipped the ring that way.
  for (const fraction of [0.3, 0.7]) {
    const layout = await page.addStyleTag({
      content: `[aria-label="Sidebar"] p { padding-block-end: ${fraction}px; }`,
    });
    await scrollToBottom(retry);
    await expectRingAboveScrollEnd();
    await layout.evaluate((element) => element.remove());
  }
  await page.unroute("**/session");
  await retry.click();
  await expect(
    page.getByRole("navigation", { name: "Subscribed channels" }),
  ).toBeVisible();
  await selectCommunity(page, "Personal space");
  const status = sidebar.getByText("Choose a community to see channels.", {
    exact: true,
  });
  await expect(status).toBeAttached();
  await scrollToBottom(status);
  await expectUnclippedFocus(sidebar.getByRole("button", { name: inboxName }));
  await sidebar.getByRole("button", { name: inboxName }).click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
});

// Pixel positions across two sidebar states need a real layout engine.
test("Personal space preserves scope control and global-row geometry", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, app);
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const geometry = () =>
    sidebar.evaluate((frame) => {
      const bounds = frame.getBoundingClientRect();
      const scope = frame.querySelector('[aria-label="Navigation scope"]');
      const rows = frame
        .querySelector('[aria-label="Pages"]')
        .querySelectorAll('[data-variant="row"]');
      return [scope, ...rows].map((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left - bounds.left,
          top: box.top - bounds.top,
          width: box.width,
        };
      });
    });
  await expect(
    page.getByRole("navigation", { name: "Subscribed channels" }),
  ).toBeVisible();
  const community = await geometry();
  await selectCommunity(page, "Personal space");
  await expect(
    sidebar.getByText("Choose a community to see channels.", { exact: true }),
  ).toBeVisible();
  expect(await geometry()).toEqual(community);
});
