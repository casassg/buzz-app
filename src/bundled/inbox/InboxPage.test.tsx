const emptyPanels: never[] = [];
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cloneElement, StrictMode, type ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { PageTabs } from "../channels/PageTabs";
import { InboxPage, type ArchiveShortcut } from "./InboxPage";
import { huddleDescription } from "../../features/huddle/lifecycle";
import { archiveKey, readArchives, updateArchive } from "./archive";
import { InboxBadge } from "./InboxBadge";
import { viewRevision, writeView } from "../../shared/view-state";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot, RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { inboxRouteTarget, type InboxRoute } from "./route";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import {
  readJournal,
  newReadJournal,
  type ReadJournal,
} from "../../features/relay/read-state-storage";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import { mediaUrl } from "../../features/relay/transport";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node host codec, with disposable test identities only.
} from "../../../browser-host/read-state.mjs";

const owners: ReturnType<typeof createRelaySession>[] = [];
composerDOMFixture();
beforeEach(() => localStorage.clear());
stubAvatarBrowserApis();
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

it.each(["reply", "message", "message after reply"])(
  "reopens archived DMs durably for an ordinary %s without resurfacing old mentions",
  async (arrival) => {
    const h = fixture({ withDm: true });
    const root = message(h.viewer, "dm-room", "DM discussion", 24);
    h.addEvent(root);
    act(() => h.emit([root]));
    const previous = message(h.alice, "dm-room", "Earlier DM mention", 25, [
      ["p", h.viewer.pubkey],
      ...(arrival === "message after reply"
        ? [["e", root.id, "", "reply"]]
        : []),
    ]);
    h.addEvent(previous);
    act(() => h.emit([previous]));
    const view = render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await chooseFilter("DMs");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0];
    if (!row) throw new Error("Missing DM row");
    fireEvent.click(within(row).getByRole("button", { name: /^Archive / }));
    await waitFor(() => expect(rows()).toHaveLength(0));
    const fresh = message(
      h.alice,
      "dm-room",
      "Ordinary DM arrival",
      Math.floor(Date.now() / 1000) + 1,
      arrival === "reply" ? [["e", root.id, "", "reply"]] : [],
    );
    h.addEvent(fresh);
    act(() => h.emit([fresh]));
    await waitFor(() =>
      expect(
        h.session.unread
          .inbox()
          .items.find((item) => item.channelId === "dm-room"),
      ).toMatchObject({
        thread: arrival !== "message",
        target: { kind: "channel" },
        messageIds: expect.arrayContaining([fresh.id]),
      }),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-inbox-row", "dm-room:dm-room");
    await chooseFilter("All activity");
    await waitFor(() => expect(rows()).toHaveLength(3));
    view.unmount();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(3));
    await chooseFilter("DMs");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await chooseFilter("Archived", "Show");
    await waitFor(() => expect(rows()).toHaveLength(0));
    await chooseFilter("Mentions");
    await waitFor(() => expect(rows()).toHaveLength(0));
    await chooseFilter("Inbox", "Show");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).not.toHaveAttribute("data-inbox-row", "dm-room:dm-room");
    await chooseFilter("Archived", "Show");
    const mention = message(
      h.alice,
      "dm-room",
      "Fresh explicit DM mention",
      Math.floor(Date.now() / 1000) + 2,
      [["p", h.viewer.pubkey]],
    );
    h.addEvent(mention);
    act(() => h.emit([mention]));
    await waitFor(() => expect(rows()).toHaveLength(0));
    await chooseFilter("Inbox", "Show");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).not.toHaveAttribute("data-inbox-row", "dm-room:dm-room");
    await chooseFilter("DMs");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-inbox-row", "dm-room:dm-room");
    expect(rows()[0]).toHaveTextContent("Fresh explicit DM mention");
  },
);

it.each([
  ["button", 0],
  ["menu", 0],
  ["button", 1],
  ["menu", 1],
] as const)(
  "Mentions row Archive via %s retains already-observed replies at cutoff + %s",
  async (action, offset) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const h = fixture();
    if (!h.root) throw new Error("Missing fixture root");
    const now = Math.floor(Date.now() / 1000);
    const mention = message(
      h.alice,
      "room",
      "Matching thread mention",
      now - 1,
      [
        ["e", h.root.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ],
    );
    const reply = message(
      h.alice,
      "room",
      "Already observed progress",
      now + offset,
      [["e", h.root.id, "", "reply"]],
    );
    h.addEvent(mention);
    h.addEvent(reply);
    act(() => h.emit([mention, reply]));
    const view = render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await chooseFilter("Mentions");
    const thread = rows().find((row) =>
      row.textContent?.includes("Matching thread mention"),
    );
    if (!thread) throw new Error("Missing matching-mention row");
    if (action === "menu") {
      fireEvent.contextMenu(
        within(thread).getByRole("button", { name: /^Open / }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Archive conversation" }),
      );
    } else {
      fireEvent.click(
        within(thread).getByRole("button", { name: /^Archive / }),
      );
    }
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(queryReader()).not.toBeInTheDocument();
    expect(readArchives(viewRevision(h.session.scope, archiveKey))).toEqual([
      expect.objectContaining({
        id: `room:${h.root.id}`,
        through: now + offset,
        messageIds: expect.arrayContaining([mention.id, reply.id]),
      }),
    ]);
    await chooseFilter("All activity");
    expect(rows()).toHaveLength(1);
    await chooseFilter("Archived", "Show");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAttribute("data-inbox-row", `room:${h.root.id}`);
    view.unmount();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-inbox-row", `room:${h.root.id}`);
    await chooseFilter("Mentions");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Matching thread mention");
  },
);

it("archives a conversation durably, restores it, and reopens for participating replies", async () => {
  const h = fixture();
  const view = render(h.view);
  const rows = () =>
    within(screen.getByRole("list", { name: "Inbox conversations" }));
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  const row = rows()
    .getAllByRole("button", { name: /^Open / })
    .find((button) => button.textContent?.includes("A thread update"));
  if (!row) throw new Error("Missing fixture thread row");
  fireEvent.click(row);
  await archiveOpened(h);
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  // The reader stays open and advances to the next conversation's tab.
  expect(reader()).toBeInTheDocument();
  expect(sideTabs()).toHaveLength(1);
  expect(rows().getByRole("listitem")).toHaveAttribute("data-selected");
  await archiveOpened(h);
  await waitFor(() =>
    expect(rows().queryAllByRole("listitem")).toHaveLength(0),
  );
  // Archiving the last conversation in view closes its tab.
  expect(queryReader()).not.toBeInTheDocument();
  expect(sideTabs()).toEqual([]);
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows().getAllByRole("listitem")).toHaveLength(2));
  const other = rows()
    .getAllByRole("button", { name: /^Restore / })
    .find(
      (button) =>
        !button.closest("li")?.textContent?.includes("A thread update"),
    );
  if (!other) throw new Error("Missing second archived row");
  fireEvent.click(other);
  await waitFor(() => expect(rows().getAllByRole("listitem")).toHaveLength(1));
  await chooseFilter("Inbox", "Show");
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  view.unmount();
  render(h.view);
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  await chooseFilter("Archived", "Show");
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  fireEvent.click(rows().getByRole("button", { name: /^Open / }));
  await archiveOpened(h);
  await waitFor(() =>
    expect(rows().queryAllByRole("button", { name: /^Open / })).toHaveLength(0),
  );
  await chooseFilter("Inbox", "Show");
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  const restoredRow = rows()
    .getAllByRole("button", { name: /^Open / })
    .find((button) => button.textContent?.includes("A thread update"));
  if (!restoredRow) throw new Error("Missing restored thread row");
  fireEvent.click(restoredRow);
  await archiveOpened(h);
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  const post = (content: string, at: number, mentioned = false) => {
    if (!h.root) throw new Error("Missing fixture thread root");
    const event = message(h.alice, "room", content, at, [
      ["e", h.root.id, "", "reply"],
      ...(mentioned ? [["p", h.viewer.pubkey]] : []),
    ]);
    h.addEvent(event);
    act(() => h.emit([event]));
  };
  const now = Math.floor(Date.now() / 1000);
  post("Agent progress", now + 1);
  await waitFor(() =>
    expect(
      h.owner.session.unread
        .inbox()
        .items.some(
          (item) => item.latestMessageId !== h.reply.id && item.thread,
        ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  post("John, please decide", now + 2, true);
  await waitFor(() =>
    expect(rows().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
});

it.each(["Threads", "Mentions"])(
  "ordinary participating replies reopen Threads and All activity but not old Mentions (arrival in %s)",
  async (activity) => {
    const h = fixture();
    if (!h.root) throw new Error("Missing fixture root");
    const root = h.root;
    let view = render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const post = (content: string, at: number, mentioned = false) => {
      const event = message(h.alice, "room", content, at, [
        ["e", root.id, "", "reply"],
        ...(mentioned ? [["p", h.viewer.pubkey]] : []),
      ]);
      h.addEvent(event);
      act(() => h.emit([event]));
      return event;
    };
    post("Earlier thread mention", 23, true);
    await chooseFilter("Threads");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const threadRow = rows()[0];
    if (!threadRow) throw new Error("Missing participating thread row");
    fireEvent.click(
      within(threadRow).getByRole("button", { name: /^Archive / }),
    );
    await waitFor(() => expect(rows()).toHaveLength(0));
    await chooseFilter(activity);
    const fresh = post(
      "New ordinary participating reply",
      Math.floor(Date.now() / 1000) + 1,
    );
    await waitFor(() =>
      expect(
        h.session.unread
          .inbox()
          .items.some((item) => item.messageIds.includes(fresh.id)),
      ).toBe(true),
    );
    await chooseFilter("Threads");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await chooseFilter("All activity");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await chooseFilter("Mentions");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review");
    view.unmount();
    view = render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review");
    await chooseFilter("Threads");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await chooseFilter("Mentions");
    post(
      "Fresh explicit thread mention",
      Math.floor(Date.now() / 1000) + 2,
      true,
    );
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
  },
);

it("archives and restores the open conversation from the Archive shortcut", async () => {
  const h = fixture();
  render(h.view);
  const list = () =>
    within(screen.getByRole("list", { name: "Inbox conversations" }));
  await waitFor(() =>
    expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  expect(h.archive.current).toBeUndefined();
  const [first] = list().getAllByRole("button", { name: /^Open / });
  if (!first) throw new Error("Missing fixture row");
  fireEvent.click(first);
  await archiveOpened(h);
  await waitFor(() =>
    expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
  );
  // Archiving the open conversation advances to the next one's tab.
  expect(list().getByRole("listitem")).toHaveAttribute("data-selected");
  expect(sideTabs()).toHaveLength(1);
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toHaveFocus(),
  );
  await chooseFilter("Archived", "Show");
  fireEvent.click(list().getByRole("button", { name: /^Open / }));
  await archiveOpened(h);
  await waitFor(() =>
    expect(list().queryAllByRole("button", { name: /^Open / })).toHaveLength(0),
  );
});

it("offers the Archive shortcut only for an opened conversation while no action is pending", async () => {
  const h = fixture();
  render(h.view);
  const list = () =>
    within(screen.getByRole("list", { name: "Inbox conversations" }));
  await waitFor(() =>
    expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(h.archive.current).toBeUndefined();
  const [first] = list().getAllByRole("button", { name: /^Open / });
  if (!first) throw new Error("Missing fixture row");
  fireEvent.click(first);
  await waitFor(() => expect(h.archive.current).toBeDefined());
  act(() => h.archive.current?.());
  // While the archive is pending, the shortcut is unavailable.
  expect(
    screen.getByRole("list", { name: "Inbox conversations" }),
  ).toHaveAttribute("aria-busy", "true");
  expect(h.archive.current).toBeUndefined();
  await waitFor(() => expect(h.archive.current).toBeDefined());
});

it.each(["shortcut", "row"])(
  "a conversation tab restored after leaving Inbox still archives and advances from its %s",
  async (from) => {
    const h = fixture();
    const view = render(h.view);
    const list = () =>
      within(screen.getByRole("list", { name: "Inbox conversations" }));
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
    );
    const [first] = list().getAllByRole("button", { name: /^Open / });
    if (!first) throw new Error("Missing fixture row");
    fireEvent.click(first);
    await waitFor(() => expect(h.archive.current).toBeDefined());
    const [tab] = sideTabs();
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    await Promise.all(h.readSteps.map((step) => step.work));
    const readSteps = h.readSteps.length;
    // Leaving Inbox and returning restores the tab with its row's selection.
    view.unmount();
    render(h.view);
    await waitFor(() => expect(sideTabs()).toEqual([tab]));
    const selected = await waitFor(() => {
      const row = list()
        .getAllByRole("listitem")
        .find((item) => item.hasAttribute("data-selected"));
      if (!row) throw new Error("No selected row");
      return row;
    });
    // Restoring the presentation must not replay the row's read command.
    expect(h.readSteps).toHaveLength(readSteps);
    if (from === "shortcut") await archiveOpened(h);
    else
      fireEvent.click(
        within(selected).getByRole("button", { name: /^Archive / }),
      );
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(1),
    );
    expect(list().getByRole("listitem")).toHaveAttribute("data-selected");
    expect(sideTabs()).toHaveLength(1);
  },
);

it.each([false, true])(
  "retires a conversation moved to the main pane when its room becomes a Huddle (focus elsewhere: %s)",
  async (elsewhere) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    const list = () =>
      within(screen.getByRole("list", { name: "Inbox conversations" }));
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
    );
    const [first] = list().getAllByRole("button", { name: /^Open / });
    if (!first) throw new Error("Missing fixture row");
    fireEvent.click(first);
    await findReader();
    const [label] = sideTabs();
    if (!label) throw new Error("Missing side tab");
    act(() => {
      fireEvent.keyDown(screen.getByRole("tab", { name: label }), {
        key: "ArrowLeft",
        altKey: true,
        shiftKey: true,
      });
    });
    expect(tabs("Inbox tabs")).toHaveLength(2);
    // Another visible control, such as the app's sidebar, keeps its focus.
    const other = document.body.appendChild(document.createElement("button"));
    if (elsewhere) other.focus();
    else (await screen.findByRole("textbox")).focus();
    const about = huddleDescription("00000000-0000-4000-8000-000000000001");
    act(() =>
      h.emit([
        metadata(h.relayKey, "room", "Huddle", 100, [
          ["private"],
          ["P", h.viewer.pubkey],
          ["about", about],
        ]),
        signed(h.viewer, {
          kind: 9007,
          created_at: 1,
          content: "",
          tags: [
            ["h", "room"],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ["about", about],
          ],
        }),
      ]),
    );
    await waitFor(() => expect(tabs("Inbox tabs")).toHaveLength(1));
    expect(queryReader()).not.toBeInTheDocument();
    if (elsewhere) expect(other).toHaveFocus();
    else
      expect(
        screen.getByRole("button", { name: "Inbox filters" }),
      ).toHaveFocus();
    other.remove();
  },
);

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "retires an opened conversation when its room becomes a Huddle (selection cleared first: %s, focus in a link dialog: %s)",
  async (cleared, dialog) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    const list = () =>
      within(screen.getByRole("list", { name: "Inbox conversations" }));
    await waitFor(() =>
      expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
    );
    const [first] = list().getAllByRole("button", { name: /^Open / });
    if (!first) throw new Error("Missing fixture row");
    fireEvent.click(first);
    await waitFor(() =>
      expect(
        reader().querySelector(`[data-message-id="${h.reply.id}"]`),
      ).toHaveFocus(),
    );
    // Showing Archived ends the selection but keeps its tab.
    if (cleared) await chooseFilter("Archived", "Show");
    (await screen.findByRole("textbox")).focus();
    if (dialog) {
      // The dialog is portalled outside the tab that owns it.
      fireEvent.click(
        screen.getByRole("button", { name: "Toggle formatting" }),
      );
      fireEvent.click(screen.getByRole("button", { name: /^Link/ }));
      const [url] = within(
        await screen.findByRole("dialog", { name: "Add link" }),
      ).getAllByRole("textbox");
      url?.focus();
      expect(url).toHaveFocus();
    }
    const about = huddleDescription("00000000-0000-4000-8000-000000000001");
    act(() =>
      h.emit([
        metadata(h.relayKey, "room", "Huddle", 100, [
          ["private"],
          ["P", h.viewer.pubkey],
          ["about", about],
        ]),
        signed(h.viewer, {
          kind: 9007,
          created_at: 1,
          content: "",
          tags: [
            ["h", "room"],
            ["visibility", "private"],
            ["channel_type", "stream"],
            ["about", about],
          ],
        }),
      ]),
    );
    await waitFor(() => expect(queryReader()).not.toBeInTheDocument());
    expect(h.archive.current).toBeUndefined();
    if (cleared) {
      expect(
        screen.getByText("This conversation is no longer available."),
      ).toBeInTheDocument();
      // The retained tab keeps focus its reader held.
      expect(document.activeElement).toHaveAttribute("role", "tab");
      expect(document.activeElement).toHaveAttribute("aria-selected", "true");
    } else {
      expect(sideTabs()).toEqual([]);
      expect(
        screen.getByRole("button", { name: "Inbox filters" }),
      ).toHaveFocus();
    }
  },
);

it("offers no Archive shortcut while Drafts is shown", async () => {
  const h = fixture();
  render(h.view);
  const list = () =>
    within(screen.getByRole("list", { name: "Inbox conversations" }));
  await waitFor(() =>
    expect(list().getAllByRole("button", { name: /^Open / })).toHaveLength(2),
  );
  const [first] = list().getAllByRole("button", { name: /^Open / });
  if (!first) throw new Error("Missing fixture row");
  fireEvent.click(first);
  await waitFor(() => expect(h.archive.current).toBeDefined());
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toHaveFocus(),
  );
  await chooseFilter("Drafts");
  await waitFor(() => expect(h.archive.current).toBeUndefined());
});

it("archives from the row without opening it, remembers filters, and resets an empty archive's filters, then its Status", async () => {
  const h = fixture();
  const view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const [first, second] = rows();
  if (!first || !second) throw new Error("Missing fixture rows");
  fireEvent.click(within(first).getByRole("button", { name: /^Archive / }));
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(queryReader()).not.toBeInTheDocument();
  expect(within(second).getByRole("button", { name: /^Open / })).toHaveFocus();

  await chooseFilter("Archived", "Show");
  await chooseFilter("Unread only", "Attention");
  view.unmount();
  render(h.view);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Inbox filters" }),
    ).toHaveTextContent("Archived"),
  );
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(rows()).toHaveLength(1);
  await chooseFilter("DMs");
  await screen.findByText("No archived conversations match Unread only");
  const filters = screen.getByRole("button", { name: "Inbox filters" });
  // Clear filters resets Type, From and Unread only, keeping Archived.
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(filters).toHaveFocus();
  expect(filters).toHaveTextContent(/^Archived$/);
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const [archived] = rows();
  if (!archived) throw new Error("Missing archived row");
  fireEvent.click(within(archived).getByRole("button", { name: /^Restore / }));
  await screen.findByText("No archived conversations in this view");
  expect(
    screen.queryByRole("button", { name: "Clear filters" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show Inbox" }));
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(filters).toHaveFocus();
  expect(filters).toHaveTextContent(/^All$/);

  // An unfiltered, empty Inbox has nothing to reset.
  for (const remaining of [1, 0]) {
    const [row] = rows();
    if (!row) throw new Error("Missing Inbox row");
    const action = within(row).getByRole("button", { name: /^Archive / });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    await waitFor(() => expect(rows()).toHaveLength(remaining));
  }
  const empty = await screen.findByText("No recent activity in this view");
  const status = empty.closest<HTMLElement>('[role="status"]');
  if (!status) throw new Error("Missing empty state");
  expect(within(status).queryAllByRole("button")).toEqual([]);
});

it.each([
  ["DMs", "Activity type"],
  ["Agents", "Sender"],
  ["Unread only", "Attention"],
] as const)(
  "offers Clear filters when %s empties Inbox, keeping Status",
  async (label, control) => {
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    if (control === "Attention")
      await act(async () => {
        await h.owner.session.unread.markChannelRead("room");
      });
    await chooseFilter(label, control);
    await screen.findByText(
      control === "Attention"
        ? "No unread activity in this view"
        : "No recent activity in this view",
    );
    expect(
      screen.queryByRole("button", { name: "Show Inbox" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const filters = screen.getByRole("button", { name: "Inbox filters" });
    expect(filters).toHaveFocus();
    expect(filters).toHaveTextContent(/^All$/);
    expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
);

it.each([
  ["button", true],
  ["menu", true],
  ["button", false],
  ["menu", false],
] as const)(
  "selected-row Archive via %s advances when a visible successor exists (%s)",
  async (action, withSuccessor) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    if (!withSuccessor) await chooseFilter("Threads");
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread) throw new Error("Missing fixture thread row");
    const open = within(thread).getByRole("button", { name: /^Open / });
    fireEvent.click(open);
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => {
      editor.insertText("Keep the selected draft");
    });
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
    if (action === "menu") {
      fireEvent.contextMenu(open);
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Archive conversation" }),
      );
    } else {
      fireEvent.click(
        within(thread).getByRole("button", { name: /^Archive / }),
      );
    }
    await waitFor(() => expect(rows()).toHaveLength(withSuccessor ? 1 : 0));
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    if (withSuccessor) {
      expect(rows()[0]).toHaveAttribute("data-selected");
      expect(sideTabs()).toHaveLength(1);
      await waitFor(() =>
        expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
      );
      expect(screen.getByRole("textbox")).not.toBe(editor);
    } else {
      expect(queryReader()).not.toBeInTheDocument();
      expect(sideTabs()).toEqual([]);
      expect(
        h.journal()?.state.frontiers[`msg:${h.mention.id}`],
      ).toBeUndefined();
    }
    await chooseFilter("Archived", "Show");
    const archivedThread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!archivedThread) throw new Error("Missing archived draft row");
    fireEvent.click(
      within(archivedThread).getByRole("button", { name: /^Open / }),
    );
    expect(await screen.findByRole("textbox")).toHaveTextContent(
      "Keep the selected draft",
    );
  },
);

it.each([
  ["shortcut", "message"],
  ["menu", "message"],
  ["shortcut", "DM"],
  ["menu", "DM"],
] as const)(
  "Archive via %s from the composer hands focus to its %s successor",
  async (action, successor) => {
    const dm = successor === "DM";
    const h = fixture({ withWriter: true, withDm: dm });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(dm ? 3 : 2));
    if (dm) {
      // Leave the DM above the opened row with nothing below it, so Archive
      // advances to the DM.
      expect(rows()[0]).toHaveTextContent("A direct reply");
      const last = rows()[2];
      if (!last) throw new Error("Missing fixture row");
      fireEvent.click(within(last).getByRole("button", { name: /^Archive / }));
      await waitFor(() => expect(rows()).toHaveLength(2));
    }
    const row = dm
      ? rows()[1]
      : rows().find((item) => item.textContent?.includes("A thread update"));
    const label = (item: HTMLElement | undefined) =>
      item && within(item).getByRole("button", { name: /^Open / }).ariaLabel;
    const after = label(rows().find((item) => item !== row));
    if (!row || !after) throw new Error("Missing fixture row");
    const open = within(row).getByRole("button", { name: /^Open / });
    fireEvent.click(open);
    (await screen.findByRole("textbox")).focus();
    if (action === "shortcut") await archiveOpened(h);
    else {
      fireEvent.contextMenu(open);
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Archive conversation" }),
      );
    }
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveAttribute("data-selected");
    expect(label(rows()[0])).toBe(after);
    expect(sideTabs()).toHaveLength(1);
    // Focus settles in the successor: a revealed message, or the composer of a
    // conversation opened without one.
    await waitFor(() => {
      const list = screen
        .getAllByRole("tablist")
        .find((item) => item.getAttribute("aria-label") !== "Inbox tabs");
      if (!list) throw new Error("Missing side tabs");
      const tab = within(list).getByRole("tab", { selected: true });
      const panel = document.getElementById(
        tab.getAttribute("aria-controls") ?? "",
      );
      expect(panel).toContainElement(document.activeElement as HTMLElement);
      if (dm) expect(document.activeElement).toHaveAttribute("role", "textbox");
    });
  },
);

it("Archive from the composer focuses the successor's tab while its message cannot be revealed", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((item) =>
    item.textContent?.includes("A thread update"),
  );
  if (!row) throw new Error("Missing fixture row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  (await screen.findByRole("textbox")).focus();
  const release = h.holdHistory("room");
  try {
    await archiveOpened(h);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review this");
    expect(rows()[0]).toHaveAttribute("data-selected");
    expect(sideTabs()).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen
          .getAllByRole("tablist")
          .find((item) => item.getAttribute("aria-label") !== "Inbox tabs")
          ?.querySelector('[role="tab"][aria-selected="true"]'),
      ),
    );
  } finally {
    await act(async () => release());
  }
});

it("the Archive shortcut advances from an ordinary-reply visit after switching to Mentions", async () => {
  const h = fixture();
  const root = h.root;
  if (!root) throw new Error("Missing fixture root");
  const mention = message(h.alice, "room", "Decision in our discussion", 23, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const progress = message(h.alice, "room", "Later ordinary progress", 24, [
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(mention);
  h.addEvent(progress);
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  act(() => h.emit([mention, progress]));
  await act(async () => {
    await h.owner.session.unread.markThrough(
      { kind: "thread", channelId: "room", rootId: root.id },
      progress.id,
    );
  });
  await screen.findByText("Later ordinary progress");
  const thread = rows().find((row) =>
    row.textContent?.includes("Later ordinary progress"),
  );
  if (!thread) throw new Error("Missing ordinary progress row");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${progress.id}"]`),
    ).toHaveFocus(),
  );
  await chooseFilter("Mentions");
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Decision in our discussion"),
    expect.stringContaining("Please review this"),
  ]);
  await waitFor(() => expect(h.archive.current).toBeDefined());
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  act(() => h.archive.current?.());
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(rows()[0]).toHaveTextContent("Please review this");
  expect(rows()[0]).toHaveAttribute("data-selected");
  expect(reader()).toBeInTheDocument();
  expect(sideTabs()).toHaveLength(1);
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
});

it.each(["button", "menu"] as const)(
  "unselected-row Archive via %s leaves the reader and its draft alone",
  async (action) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    const mention = rows().find((row) =>
      row.textContent?.includes("Please review"),
    );
    if (!thread || !mention) throw new Error("Missing fixture rows");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => editor.insertText("Keep the open draft"));
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    if (action === "menu") {
      fireEvent.contextMenu(
        within(mention).getByRole("button", { name: /^Open / }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Archive conversation" }),
      );
    } else {
      fireEvent.click(
        within(mention).getByRole("button", { name: /^Archive / }),
      );
    }
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toBe(thread);
    expect(thread).toHaveAttribute("data-selected");
    expect(screen.getByRole("textbox")).toBe(editor);
    expect(editor).toHaveTextContent("Keep the open draft");
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  },
);

it("archives and restores conversations in an active member channel across remounts", async () => {
  const h = fixture();
  let view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "room"),
  ).toMatchObject({
    members: expect.arrayContaining([h.viewer.pubkey]),
  });
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "room")
      ?.archived,
  ).toBeFalsy();
  const threadRow = () =>
    rows().find((row) => row.textContent?.includes("A thread update"));
  const thread = threadRow();
  if (!thread) throw new Error("Missing fixture thread row");
  fireEvent.click(within(thread).getByRole("button", { name: /^Archive / }));
  await waitFor(() => expect(threadRow()).toBeUndefined());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(queryReader()).not.toBeInTheDocument();

  view.unmount();
  view = render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(1));
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  const archivedThread = threadRow();
  if (!archivedThread) throw new Error("Missing archived thread row");
  fireEvent.click(
    within(archivedThread).getByRole("button", { name: /^Restore / }),
  );
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  view.unmount();
  render(h.view);
  await screen.findByText("No archived conversations in this view");
  await chooseFilter("Inbox", "Show");
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(threadRow()).toBeDefined();
});

it("defaults saved filters field by field", async () => {
  const h = fixture();
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify({ show: "archived", activity: "bogus" }),
  );
  render(h.view);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Inbox filters" }),
    ).toHaveTextContent("Archived"),
  );
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent(/^Archived$/);
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "Restore from the Archive shortcut preserves its reader/draft and unread neighbor (neighbor=%s, Retry=%s)",
  async (withNeighbor, retry) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread) throw new Error("Missing fixture thread row");
    fireEvent.click(within(thread).getByRole("button", { name: /^Archive / }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    if (withNeighbor) {
      const remaining = rows()[0];
      if (!remaining) throw new Error("Missing neighbor row");
      fireEvent.click(
        within(remaining).getByRole("button", { name: /^Archive / }),
      );
      await waitFor(() => expect(rows()).toHaveLength(0));
    }
    await chooseFilter("Archived", "Show");
    await waitFor(() => expect(rows()).toHaveLength(withNeighbor ? 2 : 1));
    const archivedThread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!archivedThread) throw new Error("Missing archived fixture thread");
    fireEvent.click(
      within(archivedThread).getByRole("button", { name: /^Open / }),
    );
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => editor.insertText("Keep the restored reader draft"));
    const list = screen.getByRole("list", { name: "Inbox conversations" });
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
    const detail = reader();
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
    const save = Storage.prototype.setItem;
    const storage = retry
      ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key,
          value,
        ) {
          if (key.includes("inbox:archives")) throw new Error("disk full");
          save.call(this, key, value);
        })
      : undefined;
    try {
      await archiveOpened(h);
      if (retry) {
        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent(
            "Could not save the Inbox archive",
          ),
        );
        expect(rows()).toHaveLength(withNeighbor ? 2 : 1);
        expect(reader()).toBe(detail);
        expect(screen.getByRole("textbox")).toBe(editor);
        expect(editor).toHaveTextContent("Keep the restored reader draft");
        expect(
          h.journal()?.state.frontiers[`msg:${h.mention.id}`],
        ).toBeUndefined();
        storage?.mockImplementation(function (this: Storage, key, value) {
          save.call(this, key, value);
        });
        fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
      }
      await waitFor(() => expect(rows()).toHaveLength(withNeighbor ? 1 : 0));
      await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
      expect(reader()).toBe(detail);
      expect(screen.getByRole("textbox")).toBe(editor);
      expect(editor).toHaveTextContent("Keep the restored reader draft");
      await waitFor(() => expect(h.archive.current).toBeDefined());
      expect(
        h.journal()?.state.frontiers[`msg:${h.mention.id}`],
      ).toBeUndefined();
      if (withNeighbor) {
        const neighbor = rows()[0];
        if (!neighbor) throw new Error("Missing unread neighbor");
        expect(
          within(neighbor).getByRole("img", { name: "Unread" }),
        ).toBeInTheDocument();
      }
    } finally {
      storage?.mockRestore();
    }
  },
);

it("keeps an archived thread and its composer mounted when a new mention reopens it", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const threadRow = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!threadRow) throw new Error("Missing fixture thread row");
  fireEvent.click(within(threadRow).getByRole("button", { name: /^Open / }));
  await findReader();
  await archiveOpened(h);
  await waitFor(() => expect(rows()).toHaveLength(1));
  // Archiving advances the reader; let its read of the next conversation settle.
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toBeInTheDocument(),
  );
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  const [archivedRow] = rows();
  if (!archivedRow) throw new Error("Missing archived thread row");
  fireEvent.click(within(archivedRow).getByRole("button", { name: /^Open / }));
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  expect(editor.insertText("Keep this draft")).toBe(true);
  expect(editor).toHaveTextContent("Keep this draft");

  if (!h.root) throw new Error("Missing fixture thread root");
  const incoming = message(
    h.alice,
    "room",
    "New mention",
    Math.floor(Date.now() / 1000) + 2,
    [
      ["e", h.root.id, "", "reply"],
      ["p", h.viewer.pubkey],
    ],
  );
  h.addEvent(incoming);
  act(() => h.emit([incoming]));

  await waitFor(() => expect(rows()).toHaveLength(0));
  expect(reader()).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveTextContent("Keep this draft");
});

it("keeps the conversation visible and reports a failed archive save", async () => {
  const h = fixture();
  render(h.view);
  const list = screen.getByRole("list", { name: "Inbox conversations" });
  await waitFor(() =>
    expect(
      within(list).getAllByRole("button", { name: /^Open / }),
    ).toHaveLength(2),
  );
  const row = within(list).getAllByRole("button", { name: /^Open / })[0];
  if (!row) throw new Error("Missing fixture row");
  fireEvent.click(row);
  await waitFor(() => expect(h.archive.current).toBeDefined());
  const save = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.includes("inbox:archives")) throw new Error("disk full");
    save.call(this, key, value);
  });
  act(() => h.archive.current?.());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save the Inbox archive",
    ),
  );
  expect(within(list).getAllByRole("button", { name: /^Open / })).toHaveLength(
    2,
  );
  expect(reader()).toBeInTheDocument();
});
it.each(["reply", "unrelated", "mention"] as const)(
  "archive Retry survives an intervening %s projection update",
  async (update) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread || !h.root) throw new Error("Missing fixture thread");
    const admitted = h.session.unread.inbox().items.find((item) => item.thread);
    if (!admitted) throw new Error("Missing admitted conversation");
    const save = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.includes("inbox:archives")) throw new Error("disk full");
        save.call(this, key, value);
      });
    fireEvent.click(within(thread).getByRole("button", { name: /^Archive / }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the Inbox archive",
    );
    storage.mockRestore();
    const incoming = message(
      h.alice,
      "room",
      `Intervening ${update}`,
      Math.floor(Date.now() / 1000) + 1,
      update === "unrelated"
        ? [["p", h.viewer.pubkey]]
        : [
            ["e", h.root.id, "", "reply"],
            ...(update === "mention" ? [["p", h.viewer.pubkey]] : []),
          ],
    );
    h.addEvent(incoming);
    act(() => h.emit([incoming]));
    await waitFor(() => {
      const current = h.session.unread.inbox().items;
      expect(current).not.toContain(admitted);
      expect(
        current.some((item) => item.messageIds.includes(incoming.id)),
      ).toBe(true);
    });
    vi.setSystemTime(new Date("2030-01-01T00:00:05Z"));
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    if (update !== "unrelated") {
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      expect(
        rows().some((row) =>
          row.textContent?.includes(`Intervening ${update}`),
        ),
      ).toBe(true);
      await chooseFilter("Archived", "Show");
      expect(rows()).toHaveLength(0);
      return;
    }
    await waitFor(() =>
      expect(
        rows().some((row) => row.textContent?.includes("A thread update")),
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await chooseFilter("Archived", "Show");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("A thread update");
  },
);

it("archive Retry cannot survive access revoke and regrant", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const thread = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!thread) throw new Error("Missing fixture thread");
  const save = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.includes("inbox:archives")) throw new Error("disk full");
      save.call(this, key, value);
    });
  fireEvent.click(within(thread).getByRole("button", { name: /^Archive / }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save the Inbox archive",
  );
  storage.mockRestore();
  act(() => {
    h.revokeRoom();
    h.restoreRoom();
  });
  await waitFor(() => expect(rows()).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Inbox action expired",
  );
  await chooseFilter("Archived", "Show");
  expect(rows()).toHaveLength(0);
});

it("archive Retry advances the reader and saves the next conversation's read frontier", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const thread = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!thread) throw new Error("Missing fixture thread row");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(h.archive.current).toBeDefined());
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  const save = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.includes("inbox:archives")) throw new Error("disk full");
      save.call(this, key, value);
    });
  act(() => h.archive.current?.());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save the Inbox archive",
  );
  expect(rows()).toHaveLength(2);
  expect(thread).toHaveAttribute("data-selected");
  storage.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(rows()[0]).toHaveAttribute("data-selected");
  expect(reader()).toBeInTheDocument();
  expect(sideTabs()).toHaveLength(1);
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
});

it.each([false, true])(
  "Archive shortcut Retry uses the current Threads list (visible successor: %s)",
  async (withSuccessor) => {
    const h = fixture();
    const root = message(h.viewer, "room", "Another discussion", 17);
    const reply = message(h.alice, "room", "Another thread update", 18, [
      ["e", root.id, "", "reply"],
    ]);
    if (withSuccessor) {
      h.addEvent(root);
      h.addEvent(reply);
      act(() => h.emit([root, reply]));
    }
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(withSuccessor ? 3 : 2));
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread) throw new Error("Missing fixture thread row");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    await waitFor(() => expect(h.archive.current).toBeDefined());
    const save = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key.includes("inbox:archives")) throw new Error("disk full");
        save.call(this, key, value);
      });
    act(() => h.archive.current?.());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the Inbox archive",
    );
    storage.mockRestore();
    await chooseFilter("Threads");
    await waitFor(() => expect(rows()).toHaveLength(withSuccessor ? 2 : 1));
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() => expect(rows()).toHaveLength(withSuccessor ? 1 : 0));
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
    if (withSuccessor) {
      expect(rows()[0]).toHaveTextContent("Another thread update");
      expect(rows()[0]).toHaveAttribute("data-selected");
      expect(sideTabs()).toHaveLength(1);
      await waitFor(() =>
        expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(18),
      );
    } else {
      expect(queryReader()).not.toBeInTheDocument();
      expect(sideTabs()).toEqual([]);
    }
    await chooseFilter("All activity");
    const mention = rows().find((row) =>
      row.textContent?.includes("Please review"),
    );
    if (!mention) throw new Error("Missing unread mention row");
    expect(
      within(mention).getByRole("img", { name: "Unread" }),
    ).toBeInTheDocument();
    expect(mention).not.toHaveAttribute("data-selected");
  },
);

it.each([false, true])(
  "sending leaves the conversation in Inbox (DM: %s)",
  async (dm) => {
    const h = fixture({ withWriter: true, withDm: dm });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(dm ? 3 : 2));
    if (dm) await chooseFilter("DMs");
    const row = rows().find((entry) =>
      entry.textContent?.includes(dm ? "A direct reply" : "A thread update"),
    );
    if (!row) throw Error("Missing send fixture row");
    fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    expect(
      screen.queryByRole("checkbox", { name: "Archive on send" }),
    ).not.toBeInTheDocument();
    act(() => {
      editor.insertText("Keep conversation open");
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(editor).toHaveValue(""));
    expect(rows()).toHaveLength(dm ? 1 : 2);
    expect(screen.getByRole("textbox")).toBe(editor);
  },
);

it("does not archive a failed send or discard its draft", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((entry) =>
    entry.textContent?.includes("A thread update"),
  );
  if (!row) throw Error("Missing thread row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  vi.spyOn(h.session.messages, "reply").mockImplementation(() => {
    throw Error("Send rejected");
  });
  act(() => {
    editor.insertText("Retain failed response");
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Send rejected");
  expect(rows()).toHaveLength(2);
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveValue("Retain failed response");
});

it("keeps an already archived conversation selected after sending in Archived", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((entry) =>
    entry.textContent?.includes("A thread update"),
  );
  if (!row) throw Error("Missing thread row");
  fireEvent.click(within(row).getByRole("button", { name: /^Archive / }));
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  const [archivedRow] = rows();
  if (!archivedRow) throw Error("Missing archived row");
  fireEvent.click(within(archivedRow).getByRole("button", { name: /^Open / }));
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  act(() => {
    editor.insertText("Archived reply");
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(editor).toHaveValue(""));
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(rows()).toHaveLength(1);
});

it("reconciles saved preferences from another window", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = rows().find((entry) =>
    entry.textContent?.includes("A thread update"),
  );
  if (!row) throw Error("Missing thread row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await screen.findByRole("textbox");
  act(() => {
    for (const [key, value] of [
      [
        "inbox:filters",
        {
          show: "all",
          activity: "bogus",
          sender: "agents",
          attention: "unread",
        },
      ],
    ] as const) {
      const storageKey = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, key])}`;
      localStorage.setItem(storageKey, JSON.stringify(value));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          storageArea: localStorage,
        }),
      );
    }
  });
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).not.toHaveTextContent("Inbox and archived");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("All");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("Agents");
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

function fixture(
  options: {
    failRoster?: boolean;
    archivedChannel?: boolean;
    withDm?: boolean;
    withSenders?: boolean;
    holdProfiles?: boolean;
    withWriter?: boolean;
    soloChannel?: boolean;
    memberAgents?: 1 | 2;
    readCapability?: "read-only" | "unsupported";
    guest?: boolean;
  } = {},
) {
  const viewer = keypair(),
    alice = keypair(),
    agent = keypair(),
    profileAgent = keypair(),
    late = keypair(),
    unknown = keypair(),
    relayKey = keypair();
  // Held profiles are unpublished until release, then arrive live. Holding a
  // read open instead would occupy the one background read slot for good.
  let profilesHeld = options.holdProfiles ?? false;
  const unheld = (found: RelayEvent[]) =>
    profilesHeld ? found.filter((event) => event.kind !== 0) : found;
  let rosterFailure = options.failRoster ?? false;
  let rosterGate: Promise<void> | undefined;
  let rosterStarted = false;
  let evidenceReads = 0;
  let unreadGate: Promise<void> | undefined;
  let unreadStarted = false;
  const historyRequests: string[] = [];
  const threadRequests: string[] = [];
  const exactRequests: string[] = [];
  const published: RelayEvent[] = [];
  const historyGates = new Map<string, Promise<void>>();
  let addressedGate: Promise<void> | undefined;
  let releaseAddressed = () => {};
  let failAux = false;
  let auxGate: Promise<void> | undefined;
  let releaseAux = () => {};
  const historyFailures = new Set<string>();
  const answer = (filter: ReadFilter): RelayEvent[] => {
    const result = events.filter((event) => matchesEvent(event, filter));
    if (filter.depth_limit) {
      return result
        .filter(
          (event) =>
            filter.thread_cursor === undefined ||
            event.created_at > filter.thread_cursor ||
            (event.created_at === filter.thread_cursor &&
              event.id > (filter.thread_cursor_id ?? "")),
        )
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit);
    }
    if (filter.top_level && filter["#h"]?.[0]) {
      return [
        ...result,
        ...events.filter(
          (event) =>
            event.kind === 5 &&
            event.tags.some(
              ([key, value]) => key === "h" && value === filter["#h"]?.[0],
            ),
        ),
        bounds(
          relayKey,
          filter["#h"][0],
          filter.until === undefined
            ? "head"
            : `${filter.until}:${filter.before_id}`,
          { has_more: false, next_cursor: null },
        ),
      ];
    }
    // The ordinary #p feed has no implicit include_aux. Exact #e pages
    // terminate only on empty even if visibility shortened an earlier page.
    if (filter["#e"])
      return result
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id > (filter.before_id ?? "")),
        )
        .slice(0, filter.limit);
    return result.slice(0, filter.limit);
  };
  let journal: ReadJournal | undefined;
  let saveFailure = false;
  let failThreadSave = false;
  let hold: Promise<void> | undefined;
  let saveStarted = false;
  let emit: (events: readonly RelayEvent[]) => void = () => {};
  const roots = [message(viewer, "room", "Our discussion", 20)];
  const mention = message(alice, "room", "Please review **this**", 21, [
    ["p", viewer.pubkey],
  ]);
  const reply = message(alice, "room", "A thread update", 22, [
    ["e", roots[0]?.id ?? "", "", "reply"],
  ]);
  const events = [
    roster(
      relayKey,
      "room",
      [
        viewer.pubkey,
        alice.pubkey,
        ...(options.memberAgents ? [agent.pubkey] : []),
        ...(options.memberAgents === 2 ? [profileAgent.pubkey] : []),
      ],
      10,
    ),
    metadata(relayKey, "room", "Design", 10, [
      ...(options.soloChannel
        ? [["t", "stream"], ["private"], ["t", "buzz.solo"]]
        : [
            ["t", "stream"],
            ...(options.archivedChannel ? [["archived", "true"]] : []),
          ]),
    ]),
    profile(alice, { name: "Alice", picture: alicePicture }),
    ...roots,
    mention,
    reply,
    ...(options.withDm
      ? [
          roster(relayKey, "dm-room", [viewer.pubkey, alice.pubkey], 10),
          metadata(relayKey, "dm-room", "Direct message", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(alice, "dm-room", "A direct reply", 23),
        ]
      : []),
    ...(options.withSenders
      ? [
          roster(relayKey, "agent-dm", [viewer.pubkey, agent.pubkey], 10),
          metadata(relayKey, "agent-dm", "Agent direct", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(agent, "agent-dm", "Agent direct reply", 24),
          message(agent, "room", "Agent mention", 25, [["p", viewer.pubkey]]),
          message(unknown, "room", "Unprofiled mention", 26, [
            ["p", viewer.pubkey],
          ]),
          profile(profileAgent, { name: "Public agent", is_agent: true }),
          message(profileAgent, "room", "Public agent mention", 27, [
            ["p", viewer.pubkey],
          ]),
          message(late, "room", "Late profile mention", 28, [
            ["p", viewer.pubkey],
          ]),
        ]
      : []),
  ];
  if (options.guest) {
    const roster = events[0];
    if (!roster) throw new Error("Missing channel roster");
    events[0] = signed(relayKey, {
      ...roster,
      tags: roster.tags.map((tag) =>
        tag[0] === "p" && tag[1] === viewer.pubkey
          ? ["p", viewer.pubkey, "", "guest"]
          : tag,
      ),
    });
  }
  if (options.readCapability) {
    journal = {
      ...newReadJournal(),
      state: {
        frontiers: { [`msg:${mention.id}`]: mention.created_at },
        overrides: {},
      },
      localUnread: { [`msg:${"f".repeat(64)}`]: 1 },
      revision: 1,
      acceptedRevision: 1,
    };
  }
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      query: async (filters) => {
        if (
          filters.some(
            (filter) =>
              filter.include_aux && !!filter["#h"] && filter.kinds?.includes(9),
          )
        ) {
          unreadStarted = true;
          await unreadGate;
        }
        if (
          filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9))
        )
          await addressedGate;
        if (
          filters.some(
            (filter) => !!filter["#e"] && filter.kinds?.includes(40003),
          )
        ) {
          await auxGate;
          if (failAux) throw new Error("auxiliary history unavailable");
        }
        if (filters.some((filter) => filter.kinds?.includes(39002))) {
          rosterStarted = true;
          if (rosterGate) await rosterGate;
          if (rosterFailure) throw new Error("roster offline");
        }
        if (filters.some((filter) => filter.kinds?.includes(9)))
          evidenceReads++;
        for (const filter of filters) {
          const channelId = filter["#h"]?.[0];
          if (filter.top_level && channelId) historyRequests.push(channelId);
          if (filter.depth_limit && channelId) threadRequests.push(channelId);
          if (filter.ids && channelId) exactRequests.push(...filter.ids);
          if (
            (filter.top_level || filter.depth_limit || filter.ids) &&
            channelId
          ) {
            await historyGates.get(channelId);
            if (historyFailures.has(channelId))
              throw new Error("history offline");
          }
        }
        return unheld(filters.flatMap(answer));
      },
      // The real sizing rewrite behind a pass-through proxy, so rows resolve
      // relay-hosted pictures to the variant they actually requested.
      media: (url, size) =>
        mediaUrl(url, (proxied) => proxied, "https://relay.test", size),
      ...(options.withWriter
        ? {
            writer: {
              kinds: [9, 9007],
              sign: async (template: import("nostr-tools").EventTemplate) =>
                signed(viewer, template),
              publish: async (event: RelayEvent) => {
                published.push(event);
              },
            },
          }
        : {}),
      ...(options.withSenders || options.memberAgents
        ? {
            readAgentLibrary: async () => ({
              definitions: [],
              identities: [
                { pubkey: agent.pubkey, name: "Scout" },
                ...(options.memberAgents === 2
                  ? [{ pubkey: profileAgent.pubkey, name: "Second agent" }]
                  : []),
              ],
            }),
          }
        : {}),
      subscribe(callbacks) {
        if (options.memberAgents)
          callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      ...(options.readCapability === "unsupported"
        ? {}
        : {
            readState: {
              decode: async (records: readonly RelayEvent[]) =>
                decodeReadState(records, viewer.secret),
              ...(options.readCapability === "read-only"
                ? {}
                : {
                    sign: async (
                      intent: import("../../features/relay/read-state-host").ReadStateSigning,
                    ) => signReadState(intent, viewer.secret),
                    publish: async (event: RelayEvent) => {
                      events.push(event);
                    },
                  }),
            },
          }),
    },
    {
      readStateFloor: () => 0,
      outboxStorage: { load: () => [], save: () => {} },
      readStateStorage: {
        async update(change) {
          if (hold) {
            saveStarted = true;
            const wait = hold;
            hold = undefined;
            await wait;
          }
          if (saveFailure) {
            saveFailure = false;
            throw new Error("disk full");
          }
          const next = readJournal(change(journal), viewer.pubkey);
          if (
            failThreadSave &&
            Object.keys(next.state.frontiers).some(
              (key) =>
                key.startsWith("thread:") &&
                next.state.frontiers[key] !== journal?.state.frontiers[key],
            )
          ) {
            failThreadSave = false;
            throw new Error("thread disk full");
          }
          journal = next;
          return journal;
        },
        close() {},
      },
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  if (!options.failRoster) emit(unheld(events));
  const scope = {
    viewer: viewer.pubkey,
    communityOrigin: "https://relay.test",
  };
  const readSteps: {
    target: Parameters<typeof owner.session.unread.markThrough>[0];
    id: string;
    work: ReturnType<typeof owner.session.unread.markThrough>;
  }[] = [];
  const retrySync = vi.fn(() => owner.session.unread.retrySync());
  const observedSession = {
    ...owner.session,
    messages: { ...owner.session.messages },
    unread: {
      ...owner.session.unread,
      retrySync,
      markThrough(
        target: Parameters<typeof owner.session.unread.markThrough>[0],
        id: string,
      ) {
        const work = owner.session.unread.markThrough(target, id);
        readSteps.push({ target, id, work });
        return work;
      },
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${scope.communityOrigin}:${scope.viewer}`,
    viewer: scope.viewer,
    session: observedSession,
  };
  const subscribers = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: owner.clearCache,
  };
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  const archive: ArchiveShortcut = {};
  const host = {
    relay,
    navigation: { open },
    panels: {
      subscribe: () => () => {},
      snapshot: () => emptyPanels,
      resolve: () => undefined,
    },
  } as unknown as ConversationHostServices;
  return {
    owner,
    session: observedSession,
    relay,
    retrySync,
    readSteps,
    evidenceReads: () => evidenceReads,
    historyRequests,
    unreadStarted: () => unreadStarted,
    holdUnread() {
      unreadStarted = false;
      let release = () => {};
      unreadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        unreadGate = undefined;
        release();
      };
    },
    holdAddressed() {
      addressedGate = new Promise<void>((resolve) => {
        releaseAddressed = resolve;
      });
      return () => {
        addressedGate = undefined;
        releaseAddressed();
      };
    },
    holdAux() {
      auxGate = new Promise<void>((resolve) => {
        releaseAux = resolve;
      });
      return () => {
        auxGate = undefined;
        releaseAux();
      };
    },
    failAux(value = true) {
      failAux = value;
    },
    threadRequests,
    exactRequests,
    published,
    addEvent(event: RelayEvent) {
      events.push(event);
    },
    deleteHistory(channelId: string) {
      const deletions = events
        .filter(
          (e) =>
            e.kind === 9 &&
            e.tags.some(([k, v]) => k === "h" && v === channelId),
        )
        .map((event) =>
          signed(event.pubkey === viewer.pubkey ? viewer : alice, {
            kind: 5,
            tags: [
              ["h", channelId],
              ["e", event.id],
            ],
            content: "",
            created_at: 200,
          }),
        );
      events.push(...deletions);
      emit(deletions);
    },
    retireThreadRoot() {
      const root = roots[0];
      if (!root) throw new Error("Missing fixture root");
      const deletion = signed(viewer, {
        kind: 5,
        tags: [
          ["h", "room"],
          ["e", root.id],
        ],
        content: "",
        created_at: 200,
      });
      events.push(deletion);
      emit([deletion]);
    },
    root: roots[0],
    failHistory(channelId: string) {
      historyFailures.add(channelId);
    },
    recoverHistory(channelId: string) {
      historyFailures.delete(channelId);
    },
    emptyHistory(channelId: string) {
      for (let i = events.length - 1; i >= 0; i--)
        if (
          events[i]?.kind === 9 &&
          events[i]?.tags.some(([k, v]) => k === "h" && v === channelId)
        )
          events.splice(i, 1);
    },
    holdHistory(channelId: string) {
      let release = () => {};
      historyGates.set(
        channelId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        historyGates.delete(channelId);
        release();
      };
    },
    rosterStarted: () => rosterStarted,
    releaseProfiles() {
      if (!profilesHeld) return;
      profilesHeld = false;
      emit(events.filter((event) => event.kind === 0));
    },
    agent,
    unknown,
    late,
    alice,
    viewer,
    relayKey,
    profileAgent,
    emit,
    events,
    publishLateProfile() {
      act(() => emit([profile(late, { name: "Late person" }, 30)]));
    },
    publishAgentProfile() {
      act(() => emit([profile(agent, { name: "Scout", is_agent: true }, 27)]));
    },
    publishMalformedProfile() {
      act(() =>
        emit([
          signed(unknown, {
            kind: 0,
            tags: [],
            content: "broken",
            created_at: 27,
          }),
        ]),
      );
    },
    recoverRoster() {
      rosterFailure = false;
      rosterStarted = false;
      let release = () => {};
      rosterGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    scope,
    mention,
    reply,
    open,
    archive,
    journal: () => journal,
    view: (
      <StrictMode>
        <InboxPage
          host={host}
          tabs={(props) => <PageTabs {...props} host={host} />}
          relay={relay}
          navigator={{ open } as unknown as Navigation}
          archive={archive}
        />
      </StrictMode>
    ),
    revokeRoom() {
      emit([roster(relayKey, "room", [alice.pubkey], 100)]);
    },
    restoreRoom() {
      const restored = roster(
        relayKey,
        "room",
        [viewer.pubkey, alice.pubkey],
        101,
      );
      events.push(restored);
      emit([restored, mention, reply, ...roots]);
    },
    archiveRoom(archived: boolean, time: number) {
      const state = metadata(relayKey, "room", "Design", time, [
        ["t", "stream"],
        ["archived", String(archived)],
      ]);
      events.push(state);
      emit([state]);
    },
    renameRoom() {
      const renamed = metadata(relayKey, "room", "Renamed", 99, [
        ["t", "stream"],
      ]);
      events.push(renamed);
      emit([renamed]);
    },
    failSave() {
      saveFailure = true;
    },
    failThreadSave() {
      failThreadSave = true;
    },
    saveStarted: () => saveStarted,
    holdSave() {
      saveStarted = false;
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    disconnect() {
      connection = { ...connection, status: "disconnected", generation: 2 };
      for (const listener of subscribers) listener();
    },
  };
}
/** Relay-hosted, so `media()` decides which variant the row loads. */
const alicePicture = `https://relay.test/media/${"a".repeat(64)}.png`;
const rows = () =>
  within(
    screen.getByRole("list", { name: "Inbox conversations" }),
  ).queryAllByRole("listitem");
/** The conversation Inbox opened in a tab beside its list. */
const reader = () => screen.getByRole("region", { name: /^Conversation in / });
const queryReader = () =>
  screen.queryByRole("region", { name: /^Conversation in / });
const findReader = () =>
  screen.findByRole("region", { name: /^Conversation in / });
const tabs = (name: string) =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
/** The side pane's tabs, beside the main pane's "Inbox tabs". */
const sideTabs = () => {
  const list = screen
    .queryAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Inbox tabs");
  return list
    ? within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    : [];
};
/** The Archive shortcut, once it acts on the conversation opened last. */
async function archiveOpened(h: { archive: ArchiveShortcut }) {
  await waitFor(() => expect(h.archive.current).toBeDefined());
  act(() => h.archive.current?.());
}
/** A visit's presentation: every open, even of the same address, is a new object. */
function visit(params?: InboxRoute): PageNavigation {
  return {
    entryId: "entry",
    target: params
      ? inboxRouteTarget(params)
      : {
          version: 1,
          kind: "page",
          pluginId: "buzz.inbox",
          pageId: "inbox",
        },
    signal: new AbortController().signal,
  } as unknown as PageNavigation;
}
/** The fixture's page, handed a navigation like the host's PageView does. */
function viewAt(h: ReturnType<typeof fixture>, navigation: PageNavigation) {
  const page = (
    h.view.props as {
      children: ReactElement<{ navigation?: PageNavigation }>;
    }
  ).children;
  return cloneElement(h.view, {}, cloneElement(page, { navigation }));
}
const savedFilters = (h: ReturnType<typeof fixture>) =>
  JSON.parse(
    localStorage.getItem(
      `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    ) ?? "null",
  );
const filterSummary = () =>
  screen.getByRole("button", { name: "Inbox filters" });
const unreadToggle = () => screen.getByRole("button", { name: "Unread only" });

it.each([
  [{ activity: "all", attention: "unread" }, "All", "true"],
  [{ activity: "threads" }, "Threads", "false"],
  [{ activity: "mentions" }, "Mentions", "false"],
  [{ activity: "dms" }, "DMs", "false"],
] as const)(
  "a shortcut open with %j applies and saves its filters, leaving the others",
  async (params, label, unread) => {
    const h = fixture({ withDm: true });
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
      JSON.stringify({
        show: "archived",
        activity: "all",
        sender: "agents",
        attention: "all",
      }),
    );
    render(viewAt(h, visit(params)));
    await waitFor(() => expect(filterSummary()).toHaveTextContent(label));
    expect(filterSummary()).not.toHaveTextContent("Archived");
    expect(unreadToggle()).toHaveAttribute("aria-pressed", unread);
    expect(savedFilters(h)).toEqual({
      show: "inbox",
      sender: "agents",
      attention: unread === "true" ? "unread" : "all",
      ...params,
    });
  },
);

it("keeps the saved attention when a shortcut names only an activity", async () => {
  const h = fixture();
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify({ attention: "unread" }),
  );
  render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Threads"));
  expect(unreadToggle()).toHaveAttribute("aria-pressed", "true");
  expect(savedFilters(h)).toMatchObject({ attention: "unread" });
});

it("re-applies a repeated shortcut open after the filters were changed by hand", async () => {
  const h = fixture({ withDm: true });
  const view = render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Threads"));
  await chooseFilter("Mentions");
  await chooseFilter("Unread only", "Attention");
  expect(filterSummary()).toHaveTextContent("Mentions");
  // A rerender of the same presentation is not a new visit.
  const same = visit({ activity: "threads" });
  view.rerender(viewAt(h, same));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Threads"));
  await chooseFilter("DMs");
  view.rerender(viewAt(h, same));
  expect(filterSummary()).toHaveTextContent("DMs");
  // The host presents a repeated open of an identical address as a new object.
  view.rerender(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Threads"));
  expect(savedFilters(h)).toMatchObject({ activity: "threads" });
});

it("Back/Forward to a shortcut visit keeps the filters chosen since", async () => {
  const h = fixture({ withDm: true });
  const view = render(viewAt(h, visit({ activity: "threads" })));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Threads"));
  await chooseFilter("Mentions");
  // Traversal presents the visit as a new object carrying the same address.
  view.rerender(
    viewAt(h, { ...visit({ activity: "threads" }), traversal: true }),
  );
  expect(filterSummary()).toHaveTextContent("Mentions");
  expect(savedFilters(h)).toMatchObject({ activity: "mentions" });
});

it("a shortcut open leaves the Drafts view", async () => {
  const h = fixture();
  const view = render(viewAt(h, visit()));
  await waitFor(() => expect(rows()).toHaveLength(2));
  await chooseFilter("Drafts");
  expect(filterSummary()).toHaveTextContent("Drafts");
  view.rerender(viewAt(h, visit({ activity: "mentions" })));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Mentions"));
  expect(filterSummary()).not.toHaveTextContent("Drafts");
  expect(
    screen.getByRole("list", { name: "Inbox conversations" }),
  ).toBeVisible();
});

it("a plain open leaves saved filters alone", async () => {
  const h = fixture();
  const saved = {
    show: "archived",
    activity: "mentions",
    sender: "humans",
    attention: "unread",
  };
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([h.owner.session.scope, "inbox:filters"])}`,
    JSON.stringify(saved),
  );
  const view = render(viewAt(h, visit()));
  await waitFor(() => expect(filterSummary()).toHaveTextContent("Archived"));
  expect(unreadToggle()).toHaveAttribute("aria-pressed", "true");
  view.rerender(viewAt(h, visit()));
  expect(savedFilters(h)).toEqual(saved);
  expect(filterSummary()).toHaveTextContent("Archived");
});

async function chooseFilter(label: string, control = "Activity type") {
  if (control === "Attention") {
    const toggle = screen.getByRole("button", { name: "Unread only" });
    if (
      toggle.getAttribute("aria-pressed") !== String(label === "Unread only")
    ) {
      fireEvent.click(toggle);
    }
    expect(toggle).toHaveAttribute(
      "aria-pressed",
      String(label === "Unread only"),
    );
    return;
  }
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Inbox filters" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu", { name: "Inbox filters" });
  const items = within(menu);
  if (control === "Show") {
    await user.click(items.getByRole("menuitemradio", { name: label }));
  } else if (control === "Sender") {
    const people = items.getByRole("menuitemcheckbox", { name: "People" });
    const agents = items.getByRole("menuitemcheckbox", { name: "Agents" });
    // Enable the desired sender before disabling the other: never select none.
    if (label !== "Agents" && people.getAttribute("aria-checked") !== "true")
      await user.click(people);
    if (label !== "Humans" && agents.getAttribute("aria-checked") !== "true")
      await user.click(agents);
    if (label === "Agents" && people.getAttribute("aria-checked") === "true")
      await user.click(people);
    if (label === "Humans" && agents.getAttribute("aria-checked") === "true")
      await user.click(agents);
    await user.keyboard("{Escape}");
  } else {
    await user.click(
      items.getByRole("menuitemradio", {
        name: label === "All activity" ? "All" : label,
      }),
    );
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", { name: "Inbox filters" }),
    ).not.toBeInTheDocument(),
  );
}
it.each([false, true])(
  "Mentions excludes ordinary thread progress (selected=%s)",
  async (selectProgress) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await act(async () => {
      await h.owner.session.unread.markThrough(
        { kind: "message", channelId: "room", messageId: h.mention.id },
        h.mention.id,
      );
    });
    const response = message(h.viewer, "room", "My answer", 30, [
      ["e", h.mention.id, "", "reply"],
    ]);
    const progress = message(h.alice, "room", "Ordinary progress", 31, [
      ["e", h.mention.id, "", "reply"],
    ]);
    h.addEvent(response);
    h.addEvent(progress);
    act(() => h.emit([response, progress]));
    if (selectProgress) {
      const progressRow = rows().find((row) =>
        row.textContent?.includes("Ordinary progress"),
      );
      if (!progressRow) throw new Error("Missing ordinary progress row");
      fireEvent.click(
        within(progressRow).getByRole("button", { name: /^Open / }),
      );
      await findReader();
      await waitFor(() =>
        expect(
          within(progressRow).getByRole("button", { name: /^Open / }),
        ).toBeEnabled(),
      );
    }
    await chooseFilter("Mentions");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Please review this");
    expect(rows()[0]).not.toHaveTextContent("Ordinary progress");
    await chooseFilter("Unread only", "Attention");
    await waitFor(() => expect(rows()).toHaveLength(0));
    const fresh = message(h.alice, "room", "Another decision", 32, [
      ["e", h.mention.id, "", "reply"],
      ["p", h.viewer.pubkey],
    ]);
    act(() => h.emit([fresh]));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Another decision");
  },
);

it("Mentions orders and classifies matching senders and reads only through matching messages", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  h.publishAgentProfile();
  const root = h.root;
  if (!root) throw new Error("Missing fixture root");
  const mention = message(h.agent, "room", "Agent decision", 23, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const progress = message(h.alice, "room", "Later human progress", 24, [
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(mention);
  h.addEvent(progress);
  act(() => h.emit([mention, progress]));
  await chooseFilter("Mentions");
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining("Agent decision"),
    expect.stringContaining("Please review this"),
  ]);
  await chooseFilter("Humans", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
  await chooseFilter("Agents", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent decision");
  const row = rows()[0];
  if (!row) throw new Error("Missing agent mention row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await findReader();
  await waitFor(() =>
    expect(h.readSteps.map((step) => step.id)).toEqual([mention.id]),
  );
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id.endsWith(root.id)),
  ).toMatchObject({ messageId: progress.id, unreadCount: 1 });
});

it("lets a joined Guest read an Inbox item and change its personal unread state", async () => {
  const h = fixture({ guest: true });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  expect(h.session.channels.get?.("room")).toMatchObject({
    viewerRole: "guest",
    readOnly: true,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByText(
      "Inbox action expired. Close and reopen the conversation.",
    ),
  ).not.toBeInTheDocument();
  fireEvent.click(await openRowMenu());
  await waitFor(() =>
    expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf(
      "number",
    ),
  );
  expect(h.session.channels.get?.("room")?.viewerRole).toBe("guest");
});

async function openRowMenu(
  method: "context" | "keyboard" | "contextKey" = "context",
) {
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  if (method === "context")
    fireEvent.contextMenu(within(row).getByRole("button", { name: /^Open / }), {
      clientX: 20,
      clientY: 20,
    });
  else {
    const open = within(row).getByRole("button", { name: /^Open / });
    open.focus();
    fireEvent.keyDown(
      open,
      method === "keyboard"
        ? { key: "F10", shiftKey: true }
        : { key: "ContextMenu" },
    );
  }
  return screen.findByRole("menuitem", { name: "Mark unread" });
}
it("excludes archived-channel mentions and threads without hiding active DMs", async () => {
  const h = fixture({ archivedChannel: true, withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("A direct reply");
  // The sender avatar reuses the thumbnail message rows load, not the original.
  expect(rows()[0]?.querySelector("img")).toHaveAttribute(
    "src",
    alicePicture.replace(/\.png$/, ".thumb.jpg"),
  );
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(0);
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(0);
});

it.each(["Please review", "A thread update"])(
  "retires the selected visit on channel archive and restores unread intent on unarchive (%s)",
  async (preview) => {
    const h = fixture({ withWriter: true });
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const row = rows().find((item) => item.textContent?.includes(preview));
    if (!row) throw new Error("Missing fixture conversation");
    fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
    const detail = await findReader();
    await within(detail).findByText(
      preview === "Please review" ? /Please review/ : "A thread update",
    );
    await waitFor(() =>
      expect(
        within(row).queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.contextMenu(within(row).getByRole("button", { name: /^Open / }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark unread" }),
    );
    await waitFor(() =>
      expect(
        within(row).getByRole("img", { name: "Unread" }),
      ).toBeInTheDocument(),
    );
    const journal = h.journal();
    act(() => h.archiveRoom(true, 100));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(queryReader()).not.toBeInTheDocument();
    expect(h.journal()).toEqual(journal);
    act(() => h.archiveRoom(false, 101));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const restored = rows().find((item) => item.textContent?.includes(preview));
    if (!restored) throw new Error("Missing restored conversation");
    expect(
      within(restored).getByRole("img", { name: "Unread" }),
    ).toBeInTheDocument();
    expect(restored).not.toHaveAttribute("data-selected");
    // Unarchiving the channel does not reopen its conversation.
    expect(queryReader()).not.toBeInTheDocument();
    expect(h.journal()).toEqual(journal);
  },
);

it("reads a reopened row again after its tab closes", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = () => {
    const item = rows().find((item) =>
      item.textContent?.includes("Please review"),
    );
    if (!item) throw new Error("Missing fixture conversation");
    return item;
  };
  const open = () =>
    fireEvent.click(within(row()).getByRole("button", { name: /^Open / }));
  const unread = () => within(row()).queryByRole("img", { name: "Unread" });
  open();
  await findReader();
  await waitFor(() => expect(unread()).not.toBeInTheDocument());
  fireEvent.contextMenu(within(row()).getByRole("button", { name: /^Open / }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() => expect(unread()).toBeInTheDocument());
  const side = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Inbox tabs");
  if (!side) throw new Error("Missing side tabs");
  fireEvent.click(within(side).getByRole("button", { name: /^Close / }));
  await waitFor(() => expect(queryReader()).not.toBeInTheDocument());
  expect(row()).not.toHaveAttribute("data-selected");
  open();
  await findReader();
  await waitFor(() => expect(unread()).not.toBeInTheDocument());
});

it.each([false, true])(
  "retires selected visits only on explicit archive during a held unread refresh (archive=%s)",
  async (archive) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await waitFor(() =>
      expect(h.owner.session.unread.inbox().status).toBe("ready"),
    );
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await within(await findReader()).findByText(/Please review/);
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    const journal = h.journal();
    const release = h.holdUnread();
    let refresh: Promise<void> | undefined;
    try {
      act(() => {
        refresh = h.owner.session.unread.refresh();
      });
      await waitFor(() => expect(h.unreadStarted()).toBe(true));
      expect(h.owner.session.unread.inbox().status).toBe("loading");
      expect(reader()).toBeInTheDocument();
      expect(rows()[0]).toHaveAttribute("data-selected");
      if (archive) {
        act(() => h.archiveRoom(true, 100));
        await waitFor(() => expect(rows()).toHaveLength(0));
        expect(queryReader()).not.toBeInTheDocument();
        act(() => h.archiveRoom(false, 101));
        await waitFor(() => expect(rows()).toHaveLength(1));
        expect(h.owner.session.unread.inbox().status).toBe("loading");
        expect(rows()[0]).not.toHaveAttribute("data-selected");
        expect(h.journal()).toEqual(journal);
      }
    } finally {
      await act(async () => {
        release();
        await refresh;
      });
    }
    await waitFor(() =>
      expect(h.owner.session.unread.inbox().status).toBe("ready"),
    );
    expect(rows()[0]?.hasAttribute("data-selected")).toBe(!archive);
    expect(h.journal()).toEqual(journal);
  },
);

it("retires a failed captured read on archive during a held unread refresh", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.unread.inbox().status).toBe("ready"),
  );
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  const release = h.holdUnread();
  let refresh: Promise<void> | undefined;
  try {
    act(() => {
      refresh = h.owner.session.unread.refresh();
    });
    await waitFor(() => expect(h.unreadStarted()).toBe(true));
    act(() => h.archiveRoom(true, 100));
    await waitFor(() => expect(rows()).toHaveLength(0));
    act(() => h.archiveRoom(false, 101));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(h.owner.session.unread.inbox().status).toBe("loading");
    expect(
      screen.queryByRole("button", { name: "Retry inbox" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      release();
      await refresh;
    });
  }
  await waitFor(() =>
    expect(h.owner.session.unread.inbox().status).toBe("ready"),
  );
  expect(rows()[0]).not.toHaveAttribute("data-selected");
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
});

it("filters real session evidence, opens an exact message and marks it read, and shares durable local unread", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(2);
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Alice in #Design" }),
  );
  // The exact message opens in a tab beside Inbox, not by navigating away.
  expect(
    (await findReader()).querySelector(`[data-message-id="${h.mention.id}"]`),
  ).toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  expect(
    h.owner.session.unread.snapshot({ kind: "channel", channelId: "room" })
      .observedCount,
  ).toBe(1);
  fireEvent.click(await openRowMenu("keyboard"));
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument(),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Open Alice in #Design" }));
  expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
  // Re-clicking reveals the message again, which takes focus.
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toHaveFocus(),
  );
  expect(
    screen.queryByText(/Marked unread on this device/),
  ).not.toBeInTheDocument();
  await chooseFilter("Unread only", "Attention");
  expect(rows()).toHaveLength(1);
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(1);
  expect(screen.getByText("A thread update")).toBeInTheDocument();
});

it("puts the actual channel or DM source below the sender without category tags", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() => expect(rows()).toHaveLength(3));
  const dmRow = rows().find((row) =>
    row.textContent?.includes("A direct reply"),
  );
  const mentionRow = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!dmRow || !mentionRow) throw new Error("Expected DM and channel rows");
  const dmSource = dmRow.querySelector("[data-inbox-source]");
  const channelSource = mentionRow.querySelector("[data-inbox-source]");
  expect(dmSource).toHaveTextContent("DM · Alice");
  expect(channelSource).toHaveTextContent("#Design");
  expect(
    within(dmRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(
    within(mentionRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(dmSource).toHaveClass(/source/);
  expect(channelSource).toHaveClass(/source/);
  expect(
    (dmSource?.compareDocumentPosition(
      within(dmRow).getByText("A direct reply"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    (channelSource?.compareDocumentPosition(
      within(mentionRow).getByText("Please review this"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const row of [dmRow, mentionRow]) {
    expect(row).not.toHaveTextContent(
      / · (Mention|Thread|Agent)|Needs action|Project update/,
    );
  }
  expect(
    within(dmRow).getByRole("button", { name: "Open Alice in DM · Alice" }),
  ).toBeInTheDocument();
  await chooseFilter("DMs");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("A direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
  await chooseFilter("All activity");
  expect(rows()).toHaveLength(3);
});

it("distinguishes same-sender thread choices by their visible safe preview", async () => {
  const h = fixture();
  const root = message(h.viewer, "room", "Another discussion", 30);
  const reply = message(h.alice, "room", "A **different** thread update", 31, [
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("A different thread update");
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(2);
  for (const preview of ["A thread update", "A different thread update"]) {
    const choice = screen.getByRole("button", {
      name: "Open Alice in #Design",
      description: preview,
    });
    expect(choice).toContainElement(screen.getByText(preview));
  }
});

it("renders all loaded rows without pagination while preserving unread filtering", async () => {
  const h = fixture();
  const extra = Array.from({ length: 49 }, (_, index) =>
    message(h.alice, "room", `Additional mention ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  h.events.push(...extra);
  h.emit(extra);
  render(h.view);
  await screen.findByText("Additional mention 48");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(51);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await h.owner.session.unread.markChannelRead("room");
  });
  await chooseFilter("Unread only", "Attention");
  expect(rows()).toHaveLength(0);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Unread only" }));
  expect(rows()).toHaveLength(51);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("intersects activity and representative sender evidence without inferring missing profiles", async () => {
  const h = fixture({ withDm: true, withSenders: true, holdProfiles: true });
  render(h.view);
  await screen.findByText("Agent direct reply");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("All");
  await chooseFilter("DMs");
  await chooseFilter("Agents", "Sender");
  // Inbox's idle-only ensure reads the shared choices; no filter-owned inventory.
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent mention");
  await chooseFilter("Humans", "Sender");
  expect(rows()).toHaveLength(0);
  try {
    await act(async () => h.releaseProfiles());
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review this");
    await chooseFilter("Agents", "Sender");
    h.publishAgentProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Public agent mention")),
    ).toBe(true);
    await chooseFilter("Humans", "Sender");
    h.publishMalformedProfile();
    h.publishLateProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Late profile mention")),
    ).toBe(true);
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(false);
    await chooseFilter("Everyone", "Sender");
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(true);
    expect(h.journal()?.state.frontiers).toEqual({}); // filtering never marks read
  } finally {
    h.releaseProfiles();
  }
});

it("offers only open and archive row buttons and preserves disabled unread via right-click", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  expect(
    within(row)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")?.split(" ")[0]),
  ).toEqual(["Open", "Archive"]);
  expect(
    within(row).queryByRole("button", { name: /^Actions for / }),
  ).not.toBeInTheDocument();
  expect(row.querySelector("[data-inbox-row-overflow]")).toBeNull();
  expect(within(row).getByRole("img", { name: "Unread" })).toBeInTheDocument();
  const action = await openRowMenu("context");
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(queryReader()).not.toBeInTheDocument();
  expect(h.journal()?.state.frontiers).toEqual({});
});

it("opens local unread actions with the ContextMenu key without changing selection", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close Thread · Design tab" }),
  );
  expect(queryReader()).not.toBeInTheDocument();
  const action = await openRowMenu("contextKey");
  expect(action).toHaveTextContent("Mark unread");
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  expect(queryReader()).not.toBeInTheDocument();
  expect(sideTabs()).toEqual([]);
  fireEvent.keyDown(action, { key: "Escape" });
});

it("holds read actions pending, surfaces storage failure, and retries without losing evidence", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  const release = h.holdSave();
  h.failSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await findReader();
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  expect(screen.getByText("Please review this")).toBeInTheDocument();
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
});

it.each([false, true])(
  "a two-step Inbox read admits the second prefix only while mounted (retire=%s)",
  async (retire) => {
    const h = fixture();
    const root = message(h.alice, "room", "Two-step root", 30, [
      ["p", h.viewer.pubkey],
    ]);
    const child = message(h.alice, "room", "Two-step reply", 31, [
      ["p", h.viewer.pubkey],
      ["e", root.id, "", "reply"],
    ]);
    h.events.push(root, child);
    h.emit([root, child]);
    render(h.view);
    await screen.findByText("Two-step reply");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    const row = h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`);
    if (!row) throw Error("Missing two-step conversation");
    expect(row.readThrough).toEqual([
      {
        target: { kind: "message", channelId: "room", messageId: root.id },
        messageId: root.id,
      },
      {
        target: { kind: "thread", channelId: "room", rootId: root.id },
        messageId: child.id,
      },
    ]);
    const release = h.holdSave();
    try {
      const target = rows().find((row) =>
        row.textContent?.includes("Two-step reply"),
      );
      if (!target) throw Error("Missing two-step row");
      fireEvent.click(within(target).getByRole("button", { name: /^Open / }));
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(h.readSteps).toHaveLength(1);
      expect(h.readSteps[0]?.id).toBe(root.id);
      if (retire) act(() => h.disconnect());
    } finally {
      await act(async () => release());
    }
    const first = h.readSteps[0];
    if (!first) throw Error("First read never started");
    await act(async () => {
      await first.work;
    });
    if (!retire) {
      await waitFor(() => expect(h.readSteps).toHaveLength(2));
      const second = h.readSteps[1];
      if (!second) throw Error("Second read never started");
      await act(async () => {
        await second.work;
      });
      expect(second.id).toBe(child.id);
      expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31);
    } else {
      expect(h.readSteps).toHaveLength(1);
      expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
      expect(
        screen.getByText("Choose a community to see your inbox."),
      ).toBeInTheDocument();
    }
    expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  },
);

it("two-step read access loss during its first save stops before the second step", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const root = message(h.alice, "room", "Cancelled root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Cancelled reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Cancelled reply");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`)?.readThrough,
  ).toHaveLength(2);
  const release = h.holdSave();
  try {
    const row = rows().find((row) =>
      row.textContent?.includes("Cancelled reply"),
    );
    if (!row) throw Error("Missing two-step row");
    await user.click(within(row).getByRole("button", { name: /^Open / }));
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    expect(h.readSteps.map((step) => step.id)).toEqual([root.id]);
    act(() => h.revokeRoom());
    expect(queryReader()).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", {
        name: "Inbox conversations",
      }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([root.id]);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reading observation expired",
  );
});

it.each(["retry", "other", "blur"] as const)(
  "held read Retry completion preserves focus ownership (%s)",
  async (focusOwner) => {
    const h = fixture();
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    h.failSave();
    await user.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    const detail = reader();
    // The exact reader has already revealed and focused its message, so no later reveal takes focus.
    await waitFor(() =>
      expect(
        detail.querySelector(`[data-message-id="${h.mention.id}"]`),
      ).toHaveFocus(),
    );
    const retry = screen.getByRole("button", { name: "Retry inbox" });
    const other = screen.getByRole("button", { name: "Unread only" });
    const release = h.holdSave();
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(h.readSteps).toHaveLength(2);
      if (focusOwner === "other") other.focus();
      if (focusOwner === "blur") retry.blur();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
    );
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
    // Focus the retired Retry owned moves to a stable Inbox control.
    if (focusOwner === "retry")
      expect(
        screen.getByRole("button", { name: "Inbox filters" }),
      ).toHaveFocus();
    else expect(focusOwner === "other" ? other : document.body).toHaveFocus();
    expect(reader()).toBe(detail);
  },
);

it("a second rejected Retry retains its focused control until a successful recovery", async () => {
  const h = fixture();
  const user = userEvent.setup();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  await user.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  const detail = reader();
  await waitFor(() =>
    expect(
      detail.querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toHaveFocus(),
  );
  const retry = screen.getByRole("button", { name: "Retry inbox" });
  const release = h.holdSave();
  h.failSave();
  try {
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    expect(retry).toHaveFocus();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", {
        name: "Inbox conversations",
      }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(retry).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Inbox filters" })).toHaveFocus();
  expect(reader()).toBe(detail);
});

it.each([true, false])(
  "source Retry stays mounted through held refresh and hands off list focus only when owned (%s)",
  async (keepFocus) => {
    const h = fixture();
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("Please review this");
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
    );
    h.failAux();
    await act(async () => h.owner.session.inboxFeed.refresh());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "auxiliary history unavailable",
    );
    h.failAux(false);
    const release = h.holdAux();
    const retry = screen.getByRole("button", { name: "Retry inbox" });
    const other = screen.getByRole("button", { name: "Unread only" });
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
          h.mention.id,
        ),
      );
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      if (!keepFocus) other.focus();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(
      keepFocus ? screen.getByRole("button", { name: "Inbox filters" }) : other,
    ).toHaveFocus();
  },
);

it("keeps the status choice focused through incoming row updates", async () => {
  const h = fixture();
  const user = userEvent.setup();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const trigger = screen.getByRole("button", { name: "Inbox filters" });
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  const archived = await screen.findByRole("menuitemradio", {
    name: "Archived",
  });
  await user.keyboard("{End}{ArrowUp}");
  await waitFor(() => expect(archived).toHaveFocus());
  const incoming = message(h.alice, "room", "Another review request", 50, [
    ["p", h.viewer.pubkey],
  ]);
  h.addEvent(incoming);
  await act(async () => h.emit([incoming]));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(archived).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(trigger).toHaveTextContent("Archived");
  expect(trigger).toHaveFocus();
});

it("shows Inbox scope as a filter without resetting attention filters", async () => {
  const h = fixture({ withSenders: true });
  render(h.view);
  await screen.findByText("Public agent mention");
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));

  const show = () => screen.getByRole("button", { name: "Inbox filters" });
  expect(show()).toHaveTextContent("All");
  expect(screen.queryByRole("group", { name: "Inbox scope" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "About Inbox archive" }),
  ).toBeNull();

  await chooseFilter("Mentions");
  await chooseFilter("Agents", "Sender");
  await waitFor(() => expect(rows()).toHaveLength(2));
  const agentRow = rows().find((row) =>
    row.textContent?.includes("Agent mention"),
  );
  if (!agentRow) throw new Error("Missing agent-authored mention");
  await chooseFilter("Unread only", "Attention");
  const agentOpen = within(agentRow).getByRole("button", { name: /^Open / });
  agentOpen.focus();
  fireEvent.keyDown(agentOpen, { key: "F10", shiftKey: true });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Archive conversation" }),
  );
  await waitFor(() => expect(rows()).toHaveLength(1));

  const expectKept = () => {
    expect(
      screen.getByRole("button", { name: "Inbox filters" }),
    ).toHaveTextContent(/Mentions.*Agents/);
    expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  };
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  expectKept();
  await chooseFilter("Inbox", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  expectKept();
  await chooseFilter("Archived", "Show");
  await waitFor(() => expect(rows()).toHaveLength(1));
  expectKept();
  const archivedRow = rows()[0];
  if (!archivedRow) throw new Error("Missing archived row");
  fireEvent.click(
    within(archivedRow).getByRole("button", { name: /^Restore / }),
  );
  await waitFor(() => expect(rows()).toHaveLength(0));
  await chooseFilter("Inbox", "Show");
  await waitFor(() => expect(rows()).toHaveLength(2));
  expectKept();
});

it("combines the existing filter choices without placeholder actions", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  const trigger = screen.getByRole("button", { name: "Inbox filters" });
  expect(trigger).toHaveTextContent("All");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("All");
  // Inbox's own tab holds the list; its filters are not tabs.
  expect(tabs("Inbox tabs")).toEqual(["Inbox"]);
  expect(
    within(screen.getByRole("tabpanel", { name: "Inbox" })).queryByRole("tab"),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: /Mark shown as read|Mark as read|Mark unread/,
    }),
  ).toBeNull();
  expect(
    screen.queryByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit|Read-state sync is unavailable on this host/,
    ),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const user = userEvent.setup();
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "Inbox filters" });
  expect(
    within(menu).getByRole("menuitemcheckbox", { name: "People" }),
  ).toBeChecked();
  expect(
    within(menu).getByRole("menuitemcheckbox", { name: "Agents" }),
  ).toBeChecked();
  for (const name of ["All", "Threads", "Mentions", "DMs", "Drafts"])
    expect(
      within(menu).getByRole("menuitemradio", { name }),
    ).toBeInTheDocument();
  for (const name of ["Projects", "Needs action", "Reactions"])
    expect(within(menu).queryByRole("menuitemradio", { name })).toBeNull();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  await chooseFilter("Drafts");
  expect(
    screen.getByRole("button", { name: "Inbox filters" }),
  ).toHaveTextContent("Drafts");
  expect(screen.queryByRole("button", { name: "Unread only" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Inbox filters" }));
  await screen.findByRole("menu", { name: "Inbox filters" });
  for (const name of ["Inbox", "Archived", "People", "Agents"])
    expect(
      screen.getByRole(
        name === "Inbox" || name === "Archived"
          ? "menuitemradio"
          : "menuitemcheckbox",
        { name },
      ),
    ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitemradio", { name: /^All$/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Inbox filters" }),
    ).toHaveTextContent("All"),
  );
  expect(
    screen.getByRole("button", { name: "Unread only" }),
  ).toBeInTheDocument();
});

it("waits for roster recovery before explicit evidence refresh", async () => {
  const h = fixture({ failRoster: true });
  render(h.view);
  expect(await screen.findByRole("alert")).toHaveTextContent("roster offline");
  const baseline = h.evidenceReads();
  const release = h.recoverRoster();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() => expect(h.rosterStarted()).toBe(true));
    expect(h.evidenceReads()).toBe(baseline);
    expect(h.retrySync).toHaveBeenCalledOnce();
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Please review this");
  expect(h.evidenceReads()).toBeGreaterThan(baseline);
});

it("cache clear shows explicit refresh instead of a spinner with no pending work", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  await act(async () => {
    await h.owner.clearCache();
  });
  expect(screen.getByText("Check recent activity.")).toBeVisible();
  expect(
    screen.queryByText("Checking recent activity…"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Please review this");
  expect(h.retrySync).not.toHaveBeenCalled();
});

it("does not accept a second row selection while its explicit read is pending", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  const release = h.holdSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
    );
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    const other = rows().find((row) =>
      row.textContent?.includes("Please review this"),
    );
    if (!other) throw Error("missing second row");
    const button = within(other).getByRole("button", { name: /^Open / });
    expect(button).toBeDisabled();
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(sideTabs()).toEqual(["Alice"]);
    expect(
      screen.getByRole("region", { name: "Conversation in Alice" }),
    ).toBeInTheDocument();
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  const other = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!other) throw Error("missing second row");
  fireEvent.click(within(other).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21),
  );
});
it("a failed captured read cannot retry after access retirement", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  act(() => h.revokeRoom());
  await waitFor(() => expect(rows()).toHaveLength(0));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Inbox action expired",
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
});
it("classifies cached profile-only agents beyond the first 50 without unbounded enrichment", async () => {
  const h = fixture();
  const agent = profile(
    h.profileAgent,
    { name: "Cached outside", is_agent: true },
    100,
  );
  const first = Array.from({ length: 51 }, (_, index) =>
    message(h.unknown, "room", `Unknown ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  const outside = message(h.profileAgent, "room", "Outside first fifty", 90, [
    ["p", h.viewer.pubkey],
  ]);
  h.events.push(agent, ...first, outside);
  h.emit([agent, ...first, outside]);
  render(h.view);
  await screen.findByText("Unknown 50");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  // Roster completion clears optional profiles; restore genuinely shared cache evidence after it.
  act(() => h.emit([agent]));
  await chooseFilter("Agents", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Outside first fifty");
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await chooseFilter("Humans", "Sender");
  expect(
    rows().some((row) => row.textContent?.includes("Outside first fifty")),
  ).toBe(false);
  act(() => h.emit([profile(h.profileAgent, { name: "Cached outside" }, 101)]));
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Outside first fifty")),
    ).toBe(true),
  );
});

it("feed invalidation has its own local recovery even when shared unread stays ready", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(h.owner.session.unread.inbox().status).toBe("ready");
  act(() => h.owner.session.inboxFeed.clear());
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
});
it("a newer manual intent invalidates retry of an earlier rejected read", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  await act(async () =>
    h.owner.session.unread.markUnreadLocal({
      kind: "message",
      channelId: "room",
      messageId: h.mention.id,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Inbox action expired",
  );
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf("number");
});

it("same-value manual writes after a failed mark-unread supersede retry even without a projection change", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  h.failSave();
  fireEvent.click(await openRowMenu());
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  // An explicit newer read at the same saved frontier has the same visual snapshot.
  await act(async () =>
    h.owner.session.unread.markThrough(
      { kind: "message", channelId: "room", messageId: h.mention.id },
      h.mention.id,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Inbox action expired",
  );
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeUndefined();
});

it("routine delayed publication does not cancel Retry for a failed mark-unread save", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBe(21);
  const revision = h.owner.session.unread.revision();
  fireEvent.contextMenu(
    within(rows()[0] as HTMLElement).getByRole("button", { name: /^Open / }),
    {
      clientX: 20,
      clientY: 20,
    },
  );
  const release = h.holdSave();
  h.failSave();
  try {
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.saveStarted()).toBe(true);
  } finally {
    await act(async () => release());
  }
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  // Run the already-scheduled publication, including its no-op storage reread.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(h.journal()?.acceptedRevision).toBe(revision);
  expect(h.owner.session.unread.revision()).toBe(revision);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf("number");
  expect(screen.queryByText("disk full")).not.toBeInTheDocument();
});

it.each([true, false])(
  "Inbox activity replies preserve shared recipient policy (solo=%s)",
  async (soloChannel) => {
    const h = fixture({ withWriter: true, soloChannel, memberAgents: 1 });
    if (soloChannel)
      writeView(h.owner.session.scope, "draft:room", {
        text: "@Scout Respond to this",
        recipients: [
          { pubkey: h.agent.pubkey, name: "Scout", start: 0, end: 6 },
        ],
      });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", {
        name: soloChannel ? "Open Alice in Design" : "Open Alice in #Design",
      }),
    );
    const editor = await screen.findByRole("textbox", {
      name: soloChannel ? "Message this conversation" : "Reply to thread",
    });
    if (!soloChannel)
      fireEvent.change(editor, { target: { value: "Respond to this" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").map((el) => el.textContent);
      const failed = h.owner.session.outbox
        ?.snapshot()
        .filter((row) => row.delivery === "failed");
      expect({ alerts, failed, published: h.published.length }).toEqual({
        alerts: [],
        failed: [],
        published: 1,
      });
    });
    const sent = h.published[0];
    if (!sent) throw Error("Missing publication");
    expect(sent.tags).toContainEqual(["h", "room"]);
    // A Solo chat is flat: Inbox replies continue it at the top level.
    expect(sent.tags.some(([name]) => name === "e")).toBe(!soloChannel);
    if (!soloChannel)
      expect(sent.tags).toContainEqual(["e", h.mention.id, "", "reply"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual(
      soloChannel ? [["p", h.agent.pubkey]] : [],
    );
  },
);
it("Inbox Solo chat activity shared with a person sends without a tag", async () => {
  const h = fixture({
    withWriter: true,
    soloChannel: true,
    memberAgents: 2,
  });
  writeView(h.owner.session.scope, "draft:room", {
    text: "No tag needed",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(screen.getByRole("button", { name: "Open Alice in Design" }));
  const editor = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  expect(editor).toHaveValue("No tag needed");
  // Alice is a member, so the viewer isn't alone with agents.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags.filter(([name]) => name === "p")).toEqual([]);
});

it("a Solo chat row includes ordinary agent responses under DMs, keeping threads separate", async () => {
  const h = fixture({ soloChannel: true, memberAgents: 1 });
  const progress = message(h.agent, "room", "Agent progress", 30);
  h.addEvent(progress);
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  act(() => h.emit([progress]));
  await waitFor(() => expect(rows()[0]).toHaveTextContent("Agent progress"));
  expect(rows()[1]).toHaveTextContent("A thread update");
  expect(screen.queryByText("Please review this")).not.toBeInTheDocument();
  await chooseFilter("DMs");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent progress");
});

it("Inbox keeps an open Solo chat timeline when a late reply regroups its mention", async () => {
  const h = fixture({
    withWriter: true,
    soloChannel: true,
    memberAgents: 1,
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(screen.getByRole("button", { name: "Open Alice in Design" }));
  const editor = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  fireEvent.change(editor, { target: { value: "Draft in progress" } });
  act(() =>
    h.emit([
      message(h.alice, "room", "Threaded follow-up", 30, [
        ["e", h.mention.id, "", "reply"],
        ["p", h.viewer.pubkey],
      ]),
    ]),
  );
  await waitFor(() =>
    expect(
      h.owner.session.unread
        .inbox()
        .items.find((item) => item.messageIds.includes(h.mention.id))?.thread,
    ).toBe(true),
  );
  await act(async () => {});
  expect(
    screen.getByRole("textbox", { name: "Message this conversation" }),
  ).toHaveValue("Draft in progress");
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  const [row] = rows();
  if (!row) throw Error("Missing regrouped row");
  // Reselecting the regrouped row keeps its Solo chat timeline.
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await act(async () => {});
  expect(
    screen.getByRole("textbox", { name: "Message this conversation" }),
  ).toHaveValue("Draft in progress");
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  // Archiving the regrouped row still closes the tab it opened.
  fireEvent.click(within(row).getByRole("button", { name: /^Archive / }));
  await waitFor(() => expect(queryReader()).not.toBeInTheDocument());
  expect(sideTabs()).toEqual([]);
});

it.each(["preview", "name", "history"])(
  "failed unread Retry survives harmless channel %s replacement",
  async (change) => {
    const h = fixture();
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Unread" }),
      ).not.toBeInTheDocument(),
    );
    const before = h.owner.session.channels
      .list()
      .channels.find((channel) => channel.id === "room");
    const revision = h.owner.session.unread.revision();
    const row = h.owner.session.unread
      .inbox()
      .items.find((row) => row.messageId === h.mention.id);
    if (!before || !row) throw Error("Missing ready evidence");
    h.failSave();
    fireEvent.click(await openRowMenu());
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    if (change === "name") act(() => h.renameRoom());
    else if (change === "preview")
      act(() => h.emit([message(h.alice, "room", "Unrelated traffic", 60)]));
    else {
      h.events.push(message(h.alice, "room", "Historical preview", 61));
      act(() => h.owner.session.channels.ensure("room"));
      await waitFor(() =>
        expect(h.owner.session.channels.window("room").status).toBe("ready"),
      );
    }
    await waitFor(() =>
      expect(
        h.owner.session.channels
          .list()
          .channels.find((channel) => channel.id === "room"),
      ).not.toBe(before),
    );
    expect(h.owner.session.unread.revision()).toBe(revision);
    expect(
      h.owner.session.unread.inbox().items.find((item) => item.id === row.id),
    ).toEqual(row);
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() =>
      expect(h.journal()?.localUnread[`msg:${h.mention.id}`]).toBeTypeOf(
        "number",
      ),
    );
  },
);
it("revoke and regrant cannot revive a captured failed Inbox mutation", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  h.failSave();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  act(() => {
    h.revokeRoom();
    h.restoreRoom();
  });
  await waitFor(() => expect(rows()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  expect(
    await screen.findByText(
      "Inbox action expired. Close and reopen the conversation.",
    ),
  ).toBeInTheDocument();
  expect(h.journal()?.state.frontiers[`msg:${h.mention.id}`]).toBeUndefined();
});

it.each(["read-only", "unsupported"] as const)(
  "%s host cannot create an unread mark it cannot clear",
  async (readCapability) => {
    const h = fixture({ readCapability });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    expect(h.owner.session.unread.sync().capability).toBe(readCapability);
    expect(rows()).toHaveLength(1);
    expect(
      within(rows()[0] as HTMLElement).queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument();
    const before = h.journal();
    if (!before) throw Error("Missing saved read state");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await screen.findByRole("region", { name: "Thread messages" });
    const action = await openRowMenu();
    expect(action).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(action);
    await act(async () => {});
    expect(h.journal()).toEqual(before);
    expect(h.journal()?.localUnread).toEqual({ [`msg:${"f".repeat(64)}`]: 1 });
  },
);
it("retiring a session removes its open unread menu without another write", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("img", { name: "Unread" }),
    ).not.toBeInTheDocument(),
  );
  const action = await openRowMenu();
  const before = h.journal();
  act(() => h.disconnect());
  expect(action).not.toBeInTheDocument();
  await act(async () => {});
  expect(h.journal()).toEqual(before);
});

it("a two-step read retries its rejected thread prefix without losing the saved first step", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Partial root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Partial reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Partial reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  h.failThreadSave();
  const row = rows().find((row) => row.textContent?.includes("Partial reply"));
  if (!row) throw Error("Missing two-step row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "thread disk full",
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([root.id, child.id]);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
});

it("All activity stays chat-only when addressed project and approval evidence arrives", async () => {
  const h = fixture();
  const nonchat = [1621, 46010].map((kind) =>
    signed(h.alice, {
      kind,
      content: `Not an Inbox conversation ${kind}`,
      created_at: 40,
      tags: [
        ["h", "room"],
        ["p", h.viewer.pubkey],
        ["a", `30617:${h.alice.pubkey}:repo`],
      ],
    }),
  );
  h.events.push(...nonchat);
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows()).toHaveLength(2);
  act(() => h.emit(nonchat));
  expect(rows()).toHaveLength(2);
  expect(screen.queryByText(/Not an Inbox conversation/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in project" })).toBeNull();
});

it("keeps the captured reply selected when its older root is verified", async () => {
  const h = fixture();
  const unknownRoot = message(h.alice, "room", "Late root", 39);
  const reply = message(h.alice, "room", "Orphan addressed reply", 42, [
    ["p", h.viewer.pubkey],
    ["e", unknownRoot.id, "", "reply"],
  ]);
  h.events.push(reply);
  h.emit([reply]);
  render(h.view);
  await screen.findByText("Orphan addressed reply");
  const row = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!row) throw Error("Missing orphan row");
  const open = within(row).getByRole("button", { name: /^Open / });
  fireEvent.click(open);
  const detail = await findReader();
  expect(open).toHaveAttribute("aria-current", "page");
  act(() => h.emit([unknownRoot]));
  expect(reader()).toBe(detail);
  expect(sideTabs()).toHaveLength(1);
  const regrouped = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!regrouped) throw Error("Missing regrouped row");
  const reopen = within(regrouped).getByRole("button", { name: /^Open / });
  expect(reopen).toHaveAttribute("aria-current", "page");
  // Reselecting the regrouped row keeps the captured visit in its one tab.
  fireEvent.click(reopen);
  expect(reopen).toHaveAttribute("aria-current", "page");
  expect(sideTabs()).toHaveLength(1);
  expect(h.open).not.toHaveBeenCalled();
});

it("a Solo chat row previewing unfinished workflow output that is not its evidence shows its placeholder", async () => {
  const h = fixture({ soloChannel: true });
  // Output attributed to the viewer without a workflow mention is not Inbox
  // evidence, but the addressed feed still settles its stored overlays.
  const output = signed(h.relayKey, {
    kind: 9,
    content: "OLD BODY",
    created_at: 39,
    tags: [
      ["h", "room"],
      ["p", h.viewer.pubkey],
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", h.viewer.pubkey],
    ],
  });
  // Fill the bounded addressed page so the row's own mention stays settled.
  h.events.unshift(
    output,
    ...Array.from({ length: 49 }, (_, i) =>
      message(h.viewer, "room", `Note ${i}`, 1 + i, [["p", h.viewer.pubkey]]),
    ),
  );
  const release = h.holdAux();
  render(h.view);
  act(() => h.emit([output]));
  const timeline = () => {
    const row = rows().find(
      (item) => !item.textContent?.includes("A thread update"),
    );
    if (!row) throw Error("Missing timeline row");
    return row;
  };
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        output.id,
      ),
    );
    expect(h.owner.session.inboxFeed.snapshot().incomplete).not.toContain(
      h.mention.id,
    );
    await waitFor(() =>
      expect(timeline()).toHaveTextContent("Preview updating…"),
    );
    expect(timeline()).not.toHaveTextContent("OLD BODY");
    h.failAux();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(timeline()).toHaveTextContent("Preview unavailable. Retry inbox."),
  );
  expect(timeline()).not.toHaveTextContent("OLD BODY");
});

it("shows only the exact unfinished row's placeholder through held edits and retry, never an unverified body", async () => {
  const h = fixture();
  const old = message(h.alice, "room", "OLD BODY", 39, [
    ["p", h.viewer.pubkey],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "CURRENT BODY",
    created_at: 40,
    tags: [
      ["h", "room"],
      ["e", old.id],
    ],
  });
  h.events.push(old, edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(old.id),
    );
    const unfinished = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!unfinished) throw Error("Missing pending preview row");
    expect(unfinished).not.toHaveTextContent("OLD BODY");
    expect(
      within(unfinished).getByRole("button", { name: /^Open / }),
    ).toHaveAccessibleDescription("Preview updating…");
    const unaffected = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    expect(unaffected).toBeDefined();
    expect(unaffected).not.toHaveTextContent("Preview updating…");
    fireEvent.click(within(unfinished).getByRole("button", { name: /^Open / }));
    expect(
      screen.getByRole("button", {
        name: /^Open /,
        current: "page",
      }),
    ).toHaveAccessibleDescription("Preview updating…");
    expect(unfinished).not.toHaveTextContent("OLD BODY");
    h.failAux();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: /^Open /,
        current: "page",
      }),
    ).toHaveAccessibleDescription("Preview unavailable. Retry inbox."),
  );
  h.failAux(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    }),
  );
  expect(
    screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    }),
  ).toHaveAccessibleDescription("CURRENT BODY");
  expect(rows().some((row) => row.textContent?.includes("CURRENT BODY"))).toBe(
    true,
  );
  expect(rows().some((row) => row.textContent?.includes("OLD BODY"))).toBe(
    false,
  );
});

it("freezes the top-level origin coordinate when read-state switches representative to a reply", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "New root mention", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reply = message(h.alice, "room", "New reply mention", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("New reply mention");
  const row = rows().find((item) =>
    item.textContent?.includes("New reply mention"),
  );
  if (!row) throw Error("Missing root mention");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(reader()).toBeInTheDocument();
  // Reading changes the row representative, not the already captured visit.
  const selectedRow = rows().find((item) =>
    item.textContent?.includes("New reply mention"),
  );
  if (!selectedRow) throw Error("Missing regrouped selected row");
  expect(selectedRow).toHaveAttribute("data-selected");
  const steps = h.readSteps.length;
  fireEvent.click(within(selectedRow).getByRole("button", { name: /^Open / }));
  expect(selectedRow).toHaveAttribute("data-selected");
  expect(sideTabs()).toHaveLength(1);
  expect(h.readSteps).toHaveLength(steps);
  expect(h.open).not.toHaveBeenCalled();
});

it("retires a deleted selected row", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const mention = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!mention) throw Error("Missing mention row");
  fireEvent.click(within(mention).getByRole("button", { name: /^Open / }));
  await findReader();
  expect(mention).toHaveAttribute("data-selected");
  act(() =>
    h.emit([
      signed(h.alice, {
        kind: 5,
        content: "",
        created_at: 99,
        tags: [
          ["h", "room"],
          ["e", h.mention.id],
        ],
      }),
    ]),
  );
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Please review this")),
    ).toBe(false),
  );
  expect(rows().some((row) => row.hasAttribute("data-selected"))).toBe(false);
});

it("keeps the exact selected group visibly incomplete when a held reply regroups under an older root", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Older root", 29);
  const reply = message(h.alice, "room", "ORIGINAL REPLY", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "Edited reply",
    created_at: 31,
    tags: [
      ["h", "room"],
      ["e", reply.id],
    ],
  });
  h.addEvent(reply);
  h.addEvent(edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        reply.id,
      ),
    );
    const original = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!original) throw Error("No pending orphan reply");
    fireEvent.click(within(original).getByRole("button", { name: /^Open / }));
    act(() => h.emit([root]));
    expect(
      h.owner.session.unread
        .inbox()
        .items.some(
          (row) =>
            row.id === `room:${root.id}` && row.messageIds.includes(reply.id),
        ),
    ).toBe(true);
    const selected = screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    });
    expect(selected).toHaveAccessibleDescription("Preview updating…");
    expect(selected.closest("li")).not.toHaveTextContent("ORIGINAL REPLY");
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().incomplete).toEqual([]),
  );
  expect(rows().some((row) => row.textContent?.includes("Edited reply"))).toBe(
    true,
  );
});

it("retries the remaining captured prefix after a harmless new reply while the second save fails", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Retry root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, "room", "Retry reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const arriving = message(h.alice, "room", "Later reply", 32, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Retry reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  h.failThreadSave();
  const row = rows().find((item) => item.textContent?.includes("Retry reply"));
  if (!row) throw Error("Missing retry row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "thread disk full",
  );
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBeUndefined();
  h.addEvent(arriving);
  act(() => h.emit([arriving]));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`thread:${root.id}`]).toBe(31),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([
    root.id,
    child.id,
    child.id,
  ]);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(30);
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `room:${root.id}`)?.messageIds,
  ).toContain(arriving.id);
});

it("preserves a failed captured read across verified root regrouping", async () => {
  const h = fixture();
  const root = message(h.alice, "room", "Late regroup root", 29);
  const orphan = message(h.alice, "room", "Regrouped reply", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(orphan);
  h.emit([orphan]);
  render(h.view);
  await screen.findByText("Regrouped reply");
  h.failSave();
  const row = rows().find((candidate) =>
    candidate.textContent?.includes("Regrouped reply"),
  );
  if (!row) throw Error("Missing orphan");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  h.addEvent(root);
  act(() => h.emit([root]));
  expect(
    h.owner.session.unread
      .inbox()
      .items.some(
        (item) =>
          item.id === `room:${root.id}` && item.messageIds.includes(orphan.id),
      ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.journal()?.state.frontiers[`msg:${orphan.id}`]).toBe(30),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([orphan.id, orphan.id]);
});

it("DM read Retry retains the original cutoff and survives re-click of the selected row", async () => {
  const clickedAt = Math.floor(Date.now() / 1000);
  const now = vi.spyOn(Date, "now").mockReturnValue(clickedAt * 1000);
  const h = fixture({ withDm: true });
  const releaseHistory = h.holdHistory("dm-room");
  try {
    render(h.view);
    await screen.findByText("A direct reply");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    const dmRow = rows().find((item) =>
      item.textContent?.includes("A direct reply"),
    );
    if (!dmRow) throw Error("Missing DM row");
    const row = within(dmRow).getByRole("button", { name: /^Open / });
    h.failSave();
    fireEvent.click(row);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    fireEvent.click(row);
    now.mockReturnValue((clickedAt + 120) * 1000);
    const later = message(
      h.alice,
      "dm-room",
      "Arrived after failed read",
      clickedAt + 61,
    );
    h.addEvent(later);
    act(() => h.emit([later]));
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() => {
      const journal = h.journal();
      if (!journal) throw Error("Expected saved read journal");
      expect(journal.state.frontiers["dm-room"]).toBe(clickedAt);
    });
    expect(h.owner.session.unread.attention("dm-room", later.id).unread).toBe(
      true,
    );
  } finally {
    await act(async () => releaseHistory());
    now.mockRestore();
  }
});

it("Retry with a ready roster waits for both evidence reads before retrying sync", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  h.failAux();
  await act(async () => h.owner.session.inboxFeed.refresh());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "auxiliary history unavailable",
  );
  h.failAux(false);
  const release = h.holdAux();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        h.mention.id,
      ),
    );
    expect(h.retrySync).not.toHaveBeenCalled();
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "true");
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.retrySync).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
});

it("opens a thread row in a side tab beside Inbox, at its exact message", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const thread = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!thread) throw Error("Missing thread row");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  const tab = await screen.findByRole("region", {
    name: "Conversation in Design",
  });
  // The list stays Inbox's own tab; the conversation opens beside it.
  expect(tabs("Inbox tabs")).toEqual(["Inbox"]);
  expect(sideTabs()).toEqual(["Thread · Design"]);
  expect(
    screen.getByRole("list", { name: "Inbox conversations" }),
  ).toBeInTheDocument();
  expect(
    within(tab).getByRole("region", { name: "Thread messages" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      tab.querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(thread).toHaveAttribute("data-selected");
  expect(h.open).not.toHaveBeenCalled();
});

it("replaces the tab the previous row opened", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = (text: string) => {
    const found = rows().find((item) => item.textContent?.includes(text));
    if (!found) throw Error(`Missing ${text} row`);
    return within(found).getByRole("button", { name: /^Open / });
  };
  fireEvent.click(row("A thread update"));
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  fireEvent.click(row("Please review"));
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.mention.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(sideTabs()).toHaveLength(1);
  expect(
    reader().querySelector(`[data-message-id="${h.reply.id}"]`),
  ).not.toBeInTheDocument();
  expect(row("Please review").closest("li")).toHaveAttribute("data-selected");
});

it("opens a DM row's whole conversation in a tab", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(3));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
  );
  const tab = await screen.findByRole("region", {
    name: "Conversation in Alice",
  });
  expect(sideTabs()).toEqual(["Alice"]);
  expect(
    within(tab).getByRole("region", { name: "Channel message history" }),
  ).toBeInTheDocument();
  expect(
    within(tab).queryByRole("region", { name: "Thread messages" }),
  ).not.toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
});

it("archives the conversation opened last from the Archive shortcut", async () => {
  const h = fixture();
  render(h.view);
  await waitFor(() => expect(rows()).toHaveLength(2));
  const row = (text: string) => {
    const found = rows().find((item) => item.textContent?.includes(text));
    if (!found) throw Error(`Missing ${text} row`);
    return within(found).getByRole("button", { name: /^Open / });
  };
  fireEvent.click(row("A thread update"));
  await waitFor(() => expect(h.archive.current).toBeDefined());
  fireEvent.click(row("Please review"));
  await archiveOpened(h);
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(rows()[0]).toHaveTextContent("A thread update");
  await waitFor(() =>
    expect(
      reader().querySelector(`[data-message-id="${h.reply.id}"]`),
    ).toHaveFocus(),
  );
  await chooseFilter("Archived", "Show");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
});

it.each([false, true])(
  "opening a conversation's tab preserves channel forced-unread intent (left channel: %s)",
  async (leftChannel) => {
    const h = fixture();
    render(h.view);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    await act(async () => {
      await h.owner.session.unread.enterChannel("room");
      await h.owner.session.unread.markMessageUnread("room", h.mention.id);
    });
    if (leftChannel) act(() => h.owner.session.unread.leaveChannel("room"));
    const force = h.journal()?.localUnread["message-force:room"];
    expect(force).toBeDefined();
    const thread = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!thread) throw Error("Missing thread row");
    fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
    const tab = await findReader();
    await waitFor(() =>
      expect(
        tab.querySelector(`[data-message-id="${h.reply.id}"]`),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Inbox conversations" }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(h.journal()?.localUnread["message-force:room"]).toBe(force);
    if (!leftChannel)
      expect(
        h.owner.session.unread.attention("room", h.mention.id).forced,
      ).toBe(true);
  },
);

it("the navigation badge counts unread Inbox conversations before Inbox opens", async () => {
  const h = fixture({ withDm: true });
  render(<InboxBadge relay={h.relay} />);
  const badge = await screen.findByRole("img", {
    name: "3 unread conversations",
  });
  expect(badge).toHaveTextContent("3");
  const thread = () => {
    const item = h.session.unread.inbox().items.find((entry) => entry.thread);
    if (!item) throw new Error("Missing thread row");
    return item;
  };
  // Archived conversations leave the count, as they leave the Inbox view.
  act(() => updateArchive(h.session.scope, thread(), true, 100));
  await screen.findByRole("img", { name: "2 unread conversations" });
  // A fresh reply in the archived thread brings it back.
  const root = h.session.unread
    .inbox()
    .items.find((entry) => entry.thread)?.rootId;
  const fresh = message(h.alice, "room", "A newer thread reply", 101, [
    ["e", root ?? "", "", "reply"],
  ]);
  h.addEvent(fresh);
  act(() => h.emit([fresh]));
  await screen.findByRole("img", { name: "3 unread conversations" });
});
