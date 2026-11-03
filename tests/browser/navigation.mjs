import { expect } from "@playwright/test";

export async function pageChoices(page, query = "") {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  await dialog
    .getByRole("combobox", { name: "Search Buzz", exact: true })
    .fill(query);
  return dialog.locator(
    '[role="group"][aria-label="Pages"], [role="rowgroup"][aria-label="Pages"]',
  );
}

export async function openPage(page, name, { connected = true } = {}) {
  // The community switcher appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: /^Community switcher:/ }),
  ).toBeVisible();
  await pageChoices(page);
  await selectPage(page, name, { connected });
}

// A Solo chat is not a page: New → New chat opens a Solo draft in Messages.
export async function newChat(page) {
  // The community switcher appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: /^Community switcher:/ }),
  ).toBeVisible();
  if (page.viewportSize().width <= 650) {
    await settleShellToggle(page);
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
  }
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New chat", exact: true }).click();
}

// The agents-only composer pill's menu adds and removes agents, never the
// last, and stays open: add this agent, drop the rest, then dismiss it, which
// returns typing to the draft.
export async function sendOnlyTo(page, pill, agent) {
  await pill.click();
  const menu = page.getByRole("dialog", { name: "Mention a member or agent" });
  const name = `${agent.name} ${agent.pubkey}`;
  const row = menu.getByRole("button", { name, exact: true });
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  const others = menu.locator(
    `[aria-pressed="true"]:not([aria-label="${name}"])`,
  );
  while (await others.count()) await others.first().click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

// Select from an already-open palette, including tests that inspect page order.
export async function selectPage(page, name, { connected = true } = {}) {
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  // Until the community connects, the palette is a placeholder. The connected
  // palette replaces it, which resets selection and option ids, so select only
  // in the final palette. Pass `connected: false` when the test holds or fails
  // the relay session: the placeholder then stays.
  await expect(
    dialog.getByText("Connecting to this community…", { exact: true }),
  ).toHaveCount(connected ? 0 : 1);
  // On CI's Linux WebKit, startup work can drop the inserted text while the
  // field stays focused and empty. Re-typing the name is idempotent; the
  // selection below is never retried.
  await expect(async () => {
    await input.fill(name);
    await expect(input).toHaveValue(name, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  const choice = pageChoice(
    dialog.locator(
      '[role="group"][aria-label="Pages"], [role="rowgroup"][aria-label="Pages"]',
    ),
    name,
  );
  // Registered page actions are visible only after the plugin catalog is ready.
  await expect(choice).toBeVisible();
  // Conversation groups above Actions arrive with the channel list and move
  // every row below them, so a pointer click can land between rows. Keyboard
  // selection follows the choice itself, not its position.
  const id = await choice.getAttribute("id");
  const limit = await dialog.locator("[role=option], [role=row]").count();
  // Establish keyboard modality without stepping past a preselected target.
  await input.press("ArrowUp");
  for (
    let step = 0;
    (await input.getAttribute("aria-activedescendant")) !== id;
    step++
  ) {
    // Rows that arrive later are inserted above the selection, so moving down
    // still reaches the choice. The bound only turns a regression into a failure.
    expect(step, `keyboard reaches ${name}`).toBeLessThan(limit + 16);
    await input.press("ArrowDown");
  }
  await input.press("Enter");
  await expect(dialog).not.toBeVisible();
}

// Activate a control by keyboard when the test is about the action, not
// pointer hit testing: a click released after the control moved (a timeline's
// re-pin after opening a thread, Virtua's pointer hold, a list's layout
// motion) reaches whatever is under the pointer instead.
export async function activate(control) {
  await control.focus();
  await expect(control).toBeFocused();
  await control.press("Enter");
}

// The shell toggle's label follows a matchMedia change listener in AppShell,
// which renders in a rendering update after page.setViewportSize() has
// resolved. A non-waiting isVisible() guard on "Show navigation" read before
// that render sees the previous width's label: it skips the click a narrow
// layout needs, or clicks a button a wide layout is about to relabel. Wait for
// the label that belongs to the current width before guarding. Pages without a
// collapsible sidebar render no toggle at wide widths; callers there settle
// only when narrow.
export async function settleShellToggle(page) {
  await expect(
    page.locator("[data-shell-sidebar-toggle]"),
  ).toHaveAccessibleName(
    page.viewportSize().width <= 650
      ? /^(Show|Hide) navigation$/
      : /^(Show|Hide) (?:Channel |Solo )?sidebar$/,
  );
}

// Settings is a modal over the retained workspace. Its sections stay in the
// modal's own navigation at every width; narrow modals stack it above the detail.
export function settingsDialog(page) {
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

export function settingsSections(page) {
  return settingsDialog(page).getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
}

export async function openSettings(page) {
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(settingsDialog(page)).toBeVisible();
}

export async function closeSettings(page) {
  await settingsDialog(page)
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await expect(settingsDialog(page)).toHaveCount(0);
}

export async function selectSettingsSection(page, name, regionName = name) {
  await settingsSections(page)
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: regionName, exact: true }),
  ).toBeVisible();
}

export async function chooseColorMode(page, name) {
  const choice = page.getByRole("combobox", { name: "Mode", exact: true });
  await choice.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(choice).toHaveText(name);
}

// Secondary panels enter with a transform and a parent grid transition.
// Positions compared across separate reads must wait for both: each read sees
// a different offset, so a fixed gap between controls can appear to overlap.
export async function settlePanelMotion(page) {
  await page
    .locator("[data-panel-dock]")
    .evaluateAll((docks) =>
      Promise.allSettled(
        docks.flatMap((dock) =>
          [
            ...dock.getAnimations({ subtree: true }),
            ...dock.parentElement.getAnimations(),
          ]
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().endTime !== Infinity,
            )
            .map((animation) => animation.finished),
        ),
      ),
    );
}

// Dialogs enter with a short upward transform (overlays.css). Positions
// compared across separate reads must wait for it, as for panels above: two
// controls in one row can otherwise appear vertically misaligned.
export async function settleDialogMotion(dialog) {
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await dialog.evaluate((element) =>
    Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    ),
  );
}

export async function openCommunityPicker(page) {
  await page.getByRole("button", { name: /^Community switcher:/ }).click();
  const picker = page.getByRole("dialog", {
    name: "Switch community",
    exact: true,
  });
  await expect(picker).toBeVisible();
  return picker;
}

export async function selectCommunity(page, name) {
  const picker = await openCommunityPicker(page);
  await picker
    .getByRole("button", {
      name: name === "Personal space" ? name : `Switch to ${name}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: `Community switcher: ${name}`,
      exact: true,
    }),
  ).toBeVisible();
}

export function pageChoice(group, name) {
  return group
    .getByRole("option", { name, exact: true })
    .or(group.getByRole("row", { name, exact: true }));
}

/** The Inbox navigation entry's name, followed by its unread count when shown. */
export const inboxName = /^Inbox(?: \d+\+? unread conversations?)?$/;
