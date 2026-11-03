// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";

afterEach(() => vi.restoreAllMocks());
it.each([
  ["MacIntel", { key: "a", mod: true, ctrl: true }],
  ["Win32", { key: "e", mod: true, shift: true }],
])("on %s, Archive waits for an open conversation", (platform, binding) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const shortcuts = { register: vi.fn() };
  apply({
    pages: { register: vi.fn() },
    relay: {},
    navigation: {},
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  const [shortcut] = shortcuts.register.mock.calls[0] ?? [];
  expect(shortcut).toMatchObject({
    id: "archive-conversation",
    binding,
    allowInEditable: true,
  });
  expect(shortcut.when()).toBe(false);
  expect(() => shortcut.run()).not.toThrow();
});

it("opens the Inbox page with filters from four chords, including from the composer", () => {
  const shortcuts = { register: vi.fn() };
  const pages = { register: vi.fn() };
  const open = vi.fn();
  apply({
    pages,
    relay: {},
    navigation: { open },
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  const registered = shortcuts.register.mock.calls.map(([item]) => item);
  const archive = registered.find((item) => item.id === "archive-conversation");
  const cases = [
    [
      "open-unread",
      "Open unread in Inbox",
      "a",
      { activity: "all", attention: "unread" },
    ],
    ["open-threads", "Open threads in Inbox", "t", { activity: "threads" }],
    ["open-mentions", "Open mentions in Inbox", "m", { activity: "mentions" }],
    ["open-dms", "Open DMs in Inbox", "k", { activity: "dms" }],
  ] as const;
  const orders = new Set<number>([archive.order]);
  for (const [id, title, key, params] of cases) {
    const shortcut = registered.find((item) => item.id === id);
    expect(shortcut).toMatchObject({
      title,
      binding: { key, mod: true, shift: true },
      allowInEditable: true,
    });
    expect(shortcut.when).toBeUndefined();
    expect(shortcut.order).toBeGreaterThan(archive.order);
    orders.add(shortcut.order);
    open.mockClear();
    shortcut.run();
    expect(open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 1, params },
    });
  }
  expect(orders.size).toBe(5);
  const [page] = pages.register.mock.calls[0] ?? [];
  expect(page.route.version).toBe(1);
  expect(page.route.validate({ activity: "threads" })).toBe(true);
  expect(page.route.validate({ activity: "bogus" })).toBe(false);
  expect(page.handlesNavigation).toBeUndefined();
});

it("registers the Inbox page with a navigation badge", () => {
  const pages = { register: vi.fn() };
  apply({
    pages,
    relay: {},
    navigation: {},
    shortcuts: { register: vi.fn() },
  } as unknown as Parameters<typeof apply>[0]);
  expect(pages.register).toHaveBeenCalledWith(
    expect.objectContaining({ id: "inbox", badge: expect.any(Function) }),
  );
});
