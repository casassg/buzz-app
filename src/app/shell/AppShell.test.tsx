import { createPortal } from "react-dom";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";
import { createAppearance } from "../../shared/theme/service";

const testAppearance = createAppearance(window);

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries or layout observers; responsive geometry is
// covered in browser tests.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
});

it("hides and shows the channel sidebar without re-rendering its content", async () => {
  const current = createServices();
  services = current;
  const renders = vi.fn();
  function Sidebar({ children }: { children: ReactNode }) {
    renders();
    return (
      <aside aria-label="Sidebar" className="shell-sidebar">
        {children}
      </aside>
    );
  }
  const sidebar = (pages: ReactNode) => <Sidebar>{pages}</Sidebar>;
  // Stable inputs, so only `selected` changes between the renders below.
  const pages: RegisteredPage[] = [
    {
      id: "channels",
      key: "buzz.channels/channels",
      pluginId: "buzz.channels",
      revision: "1",
      title: "Channels",
      component: () => null,
      primary: true,
    },
    {
      id: "inbox",
      key: "buzz.inbox/inbox",
      pluginId: "buzz.inbox",
      revision: "1",
      title: "Inbox",
      component: () => null,
      primary: true,
    },
  ];
  const onSelect = () => {};
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  const content = screen.getByRole("complementary", {
    name: "Sidebar",
  });
  const navigation = document.getElementById("shell-navigation");
  const rendered = renders.mock.calls.length;
  const row = () => within(content).getByRole("button", { name: "Inbox" });
  expect(row()).not.toHaveAttribute("aria-current");

  for (const [label, hidden] of [
    ["Hide sidebar", "true"],
    ["Show sidebar", "false"],
    ["Hide sidebar", "true"],
    ["Show sidebar", "false"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(navigation).toHaveAttribute("aria-hidden", hidden);
  }
  expect(content).toBeInTheDocument();
  expect(renders).toHaveBeenCalledTimes(rendered);

  // A selection change still reaches the page rows the sidebar renders.
  rerender(shell("buzz.inbox/inbox"));
  expect(renders.mock.calls.length).toBeGreaterThan(rendered);
  expect(row()).toHaveAttribute("aria-current", "page");
});

it("lets a plugin page hide and show the shell sidebar", async () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      primary: true,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );

  const navigation = document.getElementById("shell-navigation");
  expect(
    within(screen.getByRole("navigation", { name: "Pages" })).getByRole(
      "button",
      { name: "Beacon" },
    ),
  ).toBeInTheDocument();
  expect(navigation).toHaveAttribute("data-sidebar-collapsible");
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(navigation).toHaveAttribute("aria-hidden", "true");
  expect(navigation).toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.queryByRole("navigation", { name: "Pages" }),
  ).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(navigation).toHaveAttribute("aria-hidden", "false");
  expect(navigation).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    within(screen.getByRole("navigation", { name: "Pages" })).getByRole(
      "button",
      { name: "Beacon" },
    ),
  ).toBeInTheDocument();
});

it("does not make a non-primary plugin page's sidebar collapsible", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "secondary",
      key: "example.plugin/secondary",
      pluginId: "example.plugin",
      revision: "1",
      title: "Secondary",
      component: () => null,
      primary: false,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/secondary"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );

  expect(document.getElementById("shell-navigation")).not.toHaveAttribute(
    "data-sidebar-collapsible",
  );
  expect(
    screen.queryByRole("button", { name: "Hide sidebar" }),
  ).not.toBeInTheDocument();
});

it("keeps built-in sidebar controls available before page contributions load", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [];
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  render(shell("buzz.channels/channels"));
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("lets a non-primary page-owned sidebar collapse without losing local state", async () => {
  const current = createServices();
  services = current;
  function ContributedSidebar() {
    const [value, setValue] = useState("kept");
    return (
      <aside aria-label="Beacon sidebar" className="shell-sidebar">
        <button type="button" onClick={() => setValue("changed")}>
          {value}
        </button>
      </aside>
    );
  }
  const sidebar = () => <ContributedSidebar />;
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      sidebar: () => null,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  const nav = document.getElementById("shell-navigation");
  const contribution = screen.getByRole("complementary", {
    name: "Beacon sidebar",
  });
  await userEvent.click(
    within(contribution).getByRole("button", { name: "kept" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(nav).toHaveAttribute("inert");
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  expect(nav).toHaveAttribute("aria-hidden", "false");
  expect(
    within(contribution).getByRole("button", { name: "changed" }),
  ).toBeVisible();
});

it("keeps narrow contributed sidebars in the existing Escape-dismissed navigation drawer", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const sidebar = () => (
    <aside aria-label="Beacon sidebar" className="shell-sidebar">
      <button type="button">Sidebar action</button>
    </aside>
  );
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      sidebar: () => null,
    },
  ];
  const shell = (attempt: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt={attempt}
        onSelect={() => {}}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("first"));
  const nav = document.getElementById("shell-navigation");
  const toggle = screen.getByRole("button", { name: "Show navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(nav).toHaveAttribute("aria-hidden", "false");
  const action = screen.getByRole("button", { name: "Sidebar action" });
  action.focus();
  // Closing the drawer consumes Escape, so a window-level Escape shortcut
  // (mark as read) does not also fire.
  const reachedWindow = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
  window.addEventListener("keydown", reachedWindow);
  await userEvent.keyboard("{Escape}");
  window.removeEventListener("keydown", reachedWindow);
  expect(reachedWindow).toHaveReturnedWith(true);
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "Show navigation" })).toHaveFocus();

  await userEvent.click(
    screen.getByRole("button", { name: "Show navigation" }),
  );
  rerender(shell("second"));
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button", { name: "Show navigation" })).toBeVisible();
});

it("shows a primary plugin page's declared icon beside its nav label", () => {
  const current = createServices();
  services = current;
  const icon = "data:image/png;base64,iVBORbeacon";
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      primary: true,
      icon,
    },
  ];
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="example.plugin/main"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  const row = within(
    screen.getByRole("navigation", { name: "Pages" }),
  ).getByRole("button", { name: "Beacon" });
  const image = row.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", icon);
});

it("contains a throwing page badge to its own nav row", () => {
  const current = createServices();
  services = current;
  const page = (id: string, title: string, badge?: () => ReactNode) => ({
    id,
    key: `example.plugin/${id}`,
    pluginId: "example.plugin",
    revision: "1",
    title,
    component: () => null,
    primary: true,
    ...(badge ? { badge } : {}),
  });
  const pages: RegisteredPage[] = [
    page("broken", "Broken", () => {
      throw new Error("broken badge");
    }),
    page("healthy", "Healthy", () => <span>3</span>),
  ];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <ToastProvider>
        <AppShell
          pages={pages}
          selected="example.plugin/broken"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          content
        </AppShell>
      </ToastProvider>,
    );
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(within(nav).getByRole("button", { name: /Broken/ })).toBeVisible();
    expect(
      within(nav).getByRole("button", { name: /Healthy/ }),
    ).toHaveTextContent("3");
    expect(screen.getByText("content")).toBeInTheDocument();
  } finally {
    error.mockRestore();
  }
});

it("partitions primary pages without duplicate links and preserves exact selection and removal", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const page = (
    id: string,
    placement?: RegisteredPage["placement"],
  ): RegisteredPage => ({
    id,
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    title: id,
    primary: true,
    component: () => null,
    ...(placement ? { placement } : {}),
  });
  const pages = [
    page("Sidebar"),
    page("Topbar", "topbar"),
    page("Toolbar", "toolbar"),
    { ...page("Search only", "topbar"), primary: false },
  ];
  const shell = (entries = pages, selected = "example/Toolbar") => (
    <ToastProvider>
      <AppShell
        pages={entries}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell());
  for (const [name, landmark] of [
    ["Sidebar", "Pages"],
    ["Topbar", "Topbar pages"],
    ["Toolbar", "Toolbar pages"],
  ] as const) {
    expect(
      within(screen.getByRole("navigation", { name: landmark })).getByRole(
        name === "Topbar" ? "tab" : "button",
        { name },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole(name === "Topbar" ? "tab" : "button", { name }),
    ).toHaveLength(1);
  }
  expect(
    screen.queryByRole("button", { name: "Search only" }),
  ).not.toBeInTheDocument();
  const toolbar = screen.getByRole("button", { name: "Toolbar" });
  expect(toolbar).toHaveAttribute("aria-current", "page");
  expect(toolbar).not.toHaveAttribute("aria-expanded");
  expect(toolbar.querySelector("svg")).toBeInTheDocument();
  await userEvent.click(toolbar);
  expect(onSelect).toHaveBeenCalledWith("example/Toolbar");
  expect(document.getElementById("main-content")).toHaveFocus();
  rerender(shell(pages, "settings"));
  expect(toolbar).not.toHaveAttribute("aria-current");
  rerender(shell(pages.filter((p) => p.placement !== "toolbar")));
  expect(
    screen.queryByRole("navigation", { name: "Toolbar pages" }),
  ).not.toBeInTheDocument();
});

it("routes compact header pages through the labelled overflow with main focus handoff", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  render(
    <ToastProvider>
      <AppShell
        pages={[
          {
            id: "notes",
            key: "example/notes",
            pluginId: "example",
            revision: "one",
            title: "Notes",
            primary: true,
            placement: "topbar",
            component: () => null,
          },
        ]}
        selected="example/notes"
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  expect(
    screen.queryByRole("navigation", { name: "Topbar pages" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "More pages" }));
  const nav = await screen.findByRole("navigation", { name: "Header pages" });
  const notes = within(nav).getByRole("button", { name: "Notes" });
  expect(notes).toHaveAttribute("aria-current", "page");
  await userEvent.click(notes);
  expect(onSelect).toHaveBeenCalledWith("example/notes");
  expect(document.getElementById("main-content")).toHaveFocus();
});

it("falls back from a failed toolbar image and isolates toolbar badge errors", () => {
  const current = createServices();
  services = current;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <ToastProvider>
        <AppShell
          pages={[
            {
              id: "icon",
              key: "example/icon",
              pluginId: "example",
              revision: "one",
              title: "Icon",
              primary: true,
              placement: "toolbar",
              icon: "data:image/png,broken",
              component: () => null,
              badge: () => {
                throw new Error("bad badge");
              },
            },
          ]}
          selected="example/icon"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          content
        </AppShell>
      </ToastProvider>,
    );
    const button = screen.getByRole("button", { name: "Icon" });
    const image = button.querySelector("img");
    if (!image) throw new Error("Expected contributed page image");
    fireEvent.error(image);
    expect(button.querySelector("img")).toBeNull();
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toBeEnabled();
  } finally {
    error.mockRestore();
  }
});

it("describes a toolbar page button with its badge", () => {
  const current = createServices();
  services = current;
  render(
    <ToastProvider>
      <AppShell
        pages={[
          {
            id: "inbox",
            key: "example/inbox",
            pluginId: "example",
            revision: "one",
            title: "Inbox",
            primary: true,
            placement: "toolbar",
            component: () => null,
            badge: () => (
              <span role="img" aria-label="3 unread conversations">
                3
              </span>
            ),
          },
        ]}
        selected="example/inbox"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  const button = screen.getByRole("button", { name: "Inbox" });
  // jsdom's accname reads the described wrapper's text ("3"); Chromium and
  // Playwright's accname use the labelled image: "3 unread conversations".
  const description = document.getElementById(
    button.getAttribute("aria-describedby") ?? "",
  );
  expect(description).toContainElement(
    screen.getByRole("img", { name: "3 unread conversations" }),
  );
});

it("uses chrome tabs with manual keyboard selection, page linkage, and isolated badges", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const pages: RegisteredPage[] = ["Notes", "Messages"].map((title) => ({
    id: title,
    key: `example/${title}`,
    pluginId: "example",
    revision: "one",
    title,
    primary: true,
    placement: "topbar",
    component: () => null,
    badge: () => <span>3 unread</span>,
  }));
  const shell = (selected: string, entries = pages) => (
    <ToastProvider>
      <AppShell
        pages={entries}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        Page content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("example/Messages"));
  const tabs = screen.getByRole("tablist", { name: "Topbar pages" });
  expect(tabs.parentElement).toHaveAttribute("data-variant", "chrome");
  const messages = within(tabs).getByRole("tab", {
    name: /Messages\s*3 unread/,
  });
  const notes = within(tabs).getByRole("tab", { name: /Notes\s*3 unread/ });
  expect(messages).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("tabpanel", { name: /Messages\s*3 unread/ }),
  ).toHaveAttribute("id", messages.getAttribute("aria-controls"));
  messages.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(notes).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith("example/Notes", { focus: "preserve" });
  rerender(shell("example/Notes"));
  expect(notes).toHaveFocus();
  expect(notes).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("tabpanel", { name: /Notes\s*3 unread/ }),
  ).toHaveAttribute("id", notes.getAttribute("aria-controls"));
  rerender(shell("settings"));
  expect(within(tabs).getAllByRole("tab", { selected: false })).toHaveLength(2);
  expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  rerender(
    shell(
      "example/Notes",
      pages.filter((page) => page.id !== "Notes"),
    ),
  );
  expect(within(tabs).getAllByRole("tab", { selected: false })).toHaveLength(1);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    rerender(
      shell(
        "example/Notes",
        pages.map((page) => ({
          ...page,
          badge: () => {
            throw new Error("bad badge");
          },
        })),
      ),
    );
    expect(within(tabs).getByRole("tab", { name: "Notes" })).toBeEnabled();
  } finally {
    error.mockRestore();
  }
});

it.each([false, true])(
  "keeps Inbox in Messages and preserves sidebar visibility across pages (compact: %s)",
  async (compact) => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: compact,
      addEventListener() {},
      removeEventListener() {},
    }));
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const entries: RegisteredPage[] = [
      { key: "buzz.channels/channels", title: "Channels", placement: "topbar" },
      { key: "buzz.inbox/inbox", title: "Inbox", placement: "sidebar" },
      { key: "buzz.bestie/bestie", title: "Bestie", placement: "sidebar" },
      {
        key: "fixture.projects/projects",
        title: "Projects",
        placement: "sidebar",
      },
      { key: "example/top", title: "Top", placement: "topbar" },
      { key: "example/tool", title: "Tool", placement: "toolbar" },
    ].map((entry) => ({
      ...entry,
      placement: entry.placement as "topbar" | "sidebar" | "toolbar",
      id: entry.key.slice(entry.key.indexOf("/") + 1),
      pluginId: entry.key.slice(0, entry.key.indexOf("/")),
      revision: "one",
      primary: true,
      component: () => null,
    }));
    const shell = (selected: string, pages = entries) => (
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          <p>Child content</p>
        </AppShell>
      </ToastProvider>
    );
    const { rerender } = render(shell("buzz.inbox/inbox"));
    expect(
      within(screen.getByRole("banner")).getByRole("navigation", {
        name: "Communities",
      }),
    ).toBeVisible();
    if (!compact)
      expect(screen.getByRole("button", { name: "Inbox" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    if (compact)
      await userEvent.click(screen.getByRole("button", { name: "More pages" }));
    const nav = screen.getByRole("navigation", {
      name: compact ? "Header pages" : "Topbar pages",
    });
    const messages = within(nav).getByRole(compact ? "button" : "tab", {
      name: "Messages",
    });
    expect(messages).toHaveAttribute(
      compact ? "aria-current" : "aria-selected",
      "true",
    );
    const top = within(nav).getByRole(compact ? "button" : "tab", {
      name: "Top",
    });
    if (compact) expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    await userEvent.click(top);
    expect(onSelect).toHaveBeenCalledWith(
      "example/top",
      ...(compact ? [] : [{ focus: "preserve" }]),
    );
    if (compact) {
      expect(document.getElementById("main-content")).toHaveFocus();
      return;
    }
    expect(top).toHaveFocus();
    expect(
      within(nav).queryByRole("tab", { name: "Bestie" }),
    ).not.toBeInTheDocument();
    rerender(shell("fixture.projects/projects"));
    expect(document.getElementById("shell-navigation")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    rerender(shell("buzz.bestie/bestie"));
    expect(screen.getByRole("button", { name: "Bestie" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.getElementById("shell-navigation")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    rerender(shell("example/top"));
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    expect(top).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Top" })).toHaveTextContent(
      "Child content",
    );
    rerender(shell("example/tool"));
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tool" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    rerender(shell("buzz.inbox/inbox"));
    expect(messages).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    const panel = screen.getByRole("tabpanel", { name: "Messages" });
    expect(panel).toHaveAttribute("id", messages.getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-labelledby", messages.id);
    expect(panel).toHaveTextContent("Child content");
    await userEvent.click(messages);
    expect(onSelect).toHaveBeenLastCalledWith("buzz.channels/channels", {
      focus: "preserve",
    });
    await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    rerender(shell("fixture.projects/projects"));
    expect(document.getElementById("shell-navigation")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    rerender(shell("buzz.inbox/inbox"));
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeVisible();
    rerender(shell("settings"));
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
    onSelect.mockClear();
    rerender(shell("buzz.channels/channels"));
    await userEvent.click(messages);
    expect(onSelect).not.toHaveBeenCalled();
    rerender(
      shell(
        "buzz.inbox/inbox",
        entries.filter((entry) => entry.key !== "buzz.inbox/inbox"),
      ),
    );
    expect(
      within(nav).queryByRole("tab", { selected: true }),
    ).not.toBeInTheDocument();
  },
);

it.each([true, false])(
  "opens New with Mod+N without navigating (sidebar placement: %s)",
  async (creationInSidebar) => {
    const current = createServices();
    services = current;
    const select = vi.fn();
    const create = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <AppShell
          pages={[]}
          selected="buzz.channels/channels"
          navigationAttempt="same-conversation"
          onSelect={select}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
          searchServices={current}
          creationInSidebar={creationInSidebar}
          sidebar={(_, action) => (
            <aside aria-label="Sidebar">
              {creationInSidebar
                ? action
                : "Contributed sidebar without children"}
            </aside>
          )}
          creationAction={(open, onOpenChange, container) => (
            <MenuRoot open={open} onOpenChange={onOpenChange}>
              {container &&
                createPortal(
                  <MenuTrigger render={<button type="button">New</button>} />,
                  container,
                )}
              <MenuPopup>
                <MenuItem onClick={create}>New chat</MenuItem>
              </MenuPopup>
            </MenuRoot>
          )}
        >
          Current conversation
        </AppShell>
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(
      await screen.findByRole("menuitem", { name: "New chat" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide sidebar" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(select).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(create).toHaveBeenCalledOnce();
  },
);
