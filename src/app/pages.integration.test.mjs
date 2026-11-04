import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the app runtime exposes ready bundled pages and removes them on disable", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false },
  });
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map([
    [
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 3,
        enabled: {
          "buzz.emoji": false,
          "buzz.mentions": false,
          "buzz.reminders": false,
          "buzz.workflows": false,
        },
      }),
    ],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  let services;
  try {
    const { createServices } = await vite.ssrLoadModule("/src/app/services.ts");
    services = createServices();
    assert.deepEqual(services.pages.snapshot(), []);
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    const firstFeedback = services.accountActions.snapshot()[0];
    await services.plugins.change("disable", "buzz.feedback");
    assert.deepEqual(services.accountActions.snapshot(), []);
    await services.plugins.change("enable", "buzz.feedback");
    await vi.waitFor(() =>
      assert.equal(
        services.accountActions.snapshot()[0]?.key,
        "buzz.feedback/send",
      ),
    );
    assert.notEqual(services.accountActions.snapshot()[0], firstFeedback);
    await settle();
    assert.equal(services.pages.snapshot().length, 4);
    const { bundledPlugins } = await vite.ssrLoadModule(
      "/src/bundled/index.ts",
    );
    const { pluginCategoryDefinitions } = await vite.ssrLoadModule(
      "/src/app/plugin-categories.ts",
    );
    const categories = new Set(pluginCategoryDefinitions.map(({ id }) => id));
    for (const plugin of bundledPlugins) {
      assert.ok(
        plugin.manifest.description?.trim(),
        `${plugin.manifest.id}: description`,
      );
      assert.ok(
        categories.has(plugin.manifest.discovery?.category),
        `${plugin.manifest.id}: category`,
      );
      assert.equal(
        typeof plugin.enabledByDefault,
        "boolean",
        plugin.manifest.id,
      );
      assert.equal(
        plugin.enabledByDefault,
        ![
          "buzz.bestie",
          "buzz.opencode",
          "buzz.pi",
          "buzz.todos",
          "buzz.usage",
          "buzz.relay-notes",
          "buzz.reminders",
          "buzz.workflows",
          "buzz.focus",
        ].includes(plugin.manifest.id),
        plugin.manifest.id,
      );
    }
    for (const id of ["buzz.reminders", "buzz.workflows"]) {
      assert.equal(
        services.pages.snapshot().some((page) => page.pluginId === id),
        false,
      );
    }
    await services.plugins.change("enable", "buzz.reminders");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.reminders"),
      ),
    );
    await services.plugins.change("disable", "buzz.reminders");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.reminders"),
      false,
    );
    assert.equal(
      services.pages.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      false,
    );
    const messages = services.pages
      .snapshot()
      .find((page) => page.key === "buzz.channels/channels");
    assert.equal(messages.primary, true);
    assert.equal(messages.placement, "topbar");
    assert.equal(
      services.pages.snapshot().some((p) => p.key === "buzz.agents/attention"),
      false,
    );
    const inbox = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.inbox");
    assert.equal(inbox.title, "Inbox");
    assert.equal(inbox.layout, "workspace");
    assert.equal(inbox.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(inbox.component)),
      /Choose a community to see your inbox/,
    );
    const unread = services.relay.snapshot().session.unread;
    await services.plugins.change("disable", "buzz.inbox");
    assert.equal(
      services.pages.snapshot().some((page) => page.key === "buzz.inbox/inbox"),
      false,
    );
    assert.equal(services.relay.snapshot().session.unread, unread);
    await services.plugins.change("enable", "buzz.inbox");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.key === "buzz.inbox/inbox"),
      ),
    );
    assert.deepEqual(
      services.settingsCards
        .snapshot()
        .map((card) => card.pluginId)
        .sort(),
      [
        "block.builderlab",
        "buzz.channels",
        "buzz.emoji",
        "buzz.github",
        "buzz.pairing",
      ],
    );
    // The device-local template library remains reachable without a selected community.
    assert.equal(
      services.settingsCards
        .snapshot()
        .find((card) => card.key === "buzz.channels/templates")?.group,
      "App",
    );
    // Conversation presentation is host-owned in Appearance, not a second plugin page.
    assert.equal(services.settingsCards.has("buzz.channels/messages"), false);
    const pairingCard = services.settingsCards
      .snapshot()
      .find((card) => card.key === "buzz.pairing/mobile");
    assert.ok(pairingCard);
    // Pairing collects its own address, so it also belongs in Personal space.
    assert.equal(pairingCard.personal, true);
    await services.plugins.change("disable", "buzz.pairing");
    assert.equal(services.settingsCards.has("buzz.pairing/mobile"), false);
    await services.plugins.change("enable", "buzz.pairing");
    await vi.waitFor(() =>
      assert.ok(services.settingsCards.has("buzz.pairing/mobile")),
    );
    assert.notEqual(
      services.settingsCards
        .snapshot()
        .find((card) => card.key === "buzz.pairing/mobile"),
      pairingCard,
    );
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    const canvas = services.relay.snapshot().session.canvas;
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos")
          ?.channelLauncher,
      ),
    );
    const firstTodos = services.panels
      .snapshot()
      .find((p) => p.pluginId === "buzz.todos");
    await services.plugins.change("disable", "buzz.todos");
    assert.equal(
      services.panels.snapshot().some((p) => p.pluginId === "buzz.todos"),
      false,
    );
    assert.equal(services.relay.snapshot().session.canvas, canvas);
    await services.plugins.change("enable", "buzz.todos");
    await vi.waitFor(() =>
      assert.ok(
        services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      ),
    );
    assert.notEqual(
      services.panels.snapshot().find((p) => p.pluginId === "buzz.todos"),
      firstTodos,
    );
    await services.plugins.change("disable", "buzz.todos");
    assert.deepEqual(
      services.settingsCards
        .snapshot()
        .map((card) => card.pluginId)
        .sort(),
      [
        "block.builderlab",
        "buzz.channels",
        "buzz.emoji",
        "buzz.github",
        "buzz.pairing",
      ],
    );

    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 4),
    );
    assert.deepEqual(
      services.conversation.attachments
        .snapshot()
        .map((item) => item.pluginId)
        .sort(),
      ["buzz.agents", "buzz.voice-notes"],
    );
    await services.plugins.change("disable", "buzz.voice-notes");
    assert.deepEqual(
      services.conversation.attachments.snapshot().map((item) => item.pluginId),
      ["buzz.agents"],
    );
    assert.equal(services.conversation.inline.snapshot().length, 1);
    const linkPlugins = () =>
      services.conversation.links
        .snapshot()
        .map((link) => link.pluginId)
        .sort();
    await vi.waitFor(() =>
      assert.deepEqual(linkPlugins(), ["buzz.github", "buzz.links"]),
    );
    await services.plugins.change("disable", "buzz.links");
    assert.deepEqual(linkPlugins(), ["buzz.github"]);
    await services.plugins.change("enable", "buzz.links");
    await vi.waitFor(() =>
      assert.deepEqual(linkPlugins(), ["buzz.github", "buzz.links"]),
    );
    const tools = services.conversation.tools.snapshot();
    const inline = services.conversation.inline.snapshot();
    assert.deepEqual(tools.map((tool) => tool.pluginId).sort(), [
      "buzz.emoji",
      "buzz.mentions",
      "buzz.repos",
    ]);
    for (const id of ["buzz.emoji", "buzz.mentions"]) {
      assert.equal(await services.plugins.change("disable", id), false);
      assert.equal(services.conversation.tools.snapshot(), tools);
      assert.equal(services.conversation.inline.snapshot(), inline);
      assert.equal(services.settingsCards.has("buzz.emoji/custom-emoji"), true);
    }

    const { npubEncode } = await import("nostr-tools/nip19");
    const profileTarget = `nostr:${npubEncode("ab".repeat(32))}`;
    assert.equal(
      services.panels.resolve(profileTarget)?.pluginId,
      "buzz.profiles",
    );
    await services.plugins.change("disable", "buzz.profiles");
    assert.equal(services.panels.resolve(profileTarget), undefined);
    await services.plugins.change("enable", "buzz.profiles");
    await vi.waitFor(() =>
      assert.equal(
        services.panels.resolve(profileTarget)?.pluginId,
        "buzz.profiles",
      ),
    );

    assert.ok(
      !services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.agent-activity"),
    );
    assert.equal(services.conversation.accessories.snapshot().length, 2);
    assert.deepEqual(
      services.conversation.accessories
        .snapshot()
        .map(({ id, placement }) => [id, placement]),
      [
        ["activity", "response"],
        ["typing-presentation", undefined],
      ],
    );
    assert.equal(
      services.conversation.accessories.snapshot()[0].pluginId,
      "buzz.agent-activity",
    );
    await services.plugins.change("disable", "buzz.agent-activity");
    assert.equal(services.conversation.accessories.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.agent-activity");
    await vi.waitFor(() =>
      assert.equal(services.conversation.accessories.snapshot().length, 2),
    );

    await services.plugins.change("enable", "buzz.bestie");
    await vi.waitFor(() =>
      assert.ok(
        services.pages.snapshot().some((p) => p.pluginId === "buzz.bestie"),
      ),
    );
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    const bestiePage = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.bestie");
    assert.equal(bestiePage.title, "Bestie");
    assert.equal(bestiePage.layout, "workspace");
    assert.equal(bestiePage.primary, true);
    assert.match(
      renderToStaticMarkup(createElement(bestiePage.component)),
      /Choose a community to continue with your Bestie\./,
    );
    await services.plugins.change("disable", "buzz.bestie");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(
      services.pages.snapshot().some((page) => page.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(services.pages.snapshot().length, 4);
    await services.plugins.change("enable", "buzz.bestie");
    // Management completion is not activation completion; Cordis still owns import/disposal barriers.
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.bestie"),
      ),
    );
    const secondBestie = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.bestie");
    assert.notEqual(secondBestie, bestiePage);
    assert.equal(secondBestie.revision, bestiePage.revision);
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    const page = services.pages.snapshot()[0];
    assert.match(
      renderToStaticMarkup(createElement(page.component)),
      /Your channels, one conversation/,
    );
    const session = services.relay.snapshot().session;
    const nameFacts = [
      { pubkey: "a".repeat(64), name: "Alex" },
      { pubkey: "b".repeat(64), name: "Alex" },
    ];
    const named = () =>
      session.names.resolve(
        nameFacts[0].pubkey,
        "Unknown",
        nameFacts.map((row) => row.pubkey),
        nameFacts,
      );
    const qualified = named();
    assert.match(qualified, /^Alex · /);
    await services.plugins.change("disable", "buzz.identity-naming");
    assert.equal(named(), "Unknown");
    await services.plugins.change("enable", "buzz.identity-naming");
    await vi.waitFor(() => assert.equal(named(), qualified));
    assert.ok(session.agentLibrary);
    await services.plugins.change("enable", "buzz.workflows");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.workflows"),
      ),
    );
    const workflows = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.workflows");
    assert.equal(workflows.title, "Workflows");
    assert.equal(workflows.layout, "workspace");
    assert.match(
      renderToStaticMarkup(createElement(workflows.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      services.pages
        .snapshot()
        .some((page) => page.pluginId === "buzz.workflows"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    assert.ok(session.workflows);
    await services.plugins.change("enable", "buzz.workflows");
    await vi.waitFor(() =>
      assert.ok(
        services.pages
          .snapshot()
          .some((page) => page.pluginId === "buzz.workflows"),
      ),
    );
    await services.plugins.change("disable", "buzz.workflows");
    assert.equal(
      await services.plugins.change("disable", "buzz.channels"),
      false,
    );
    const projects = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.repos");
    assert.equal(services.pages.snapshot().length, 5);
    assert.equal(projects.pluginId, "buzz.repos");
    assert.equal(projects.id, "repos");
    assert.equal(projects.title, "Repository");
    assert.equal(projects.layout, "workspace");
    assert.equal(projects.handlesNavigation, true);
    assert.equal(projects.primary, false);
    assert.equal(projects.route.version, 1);
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
      }),
      true,
    );
    assert.equal(
      projects.route.validate({
        type: "repo",
        owner: "a".repeat(64),
        dtag: "repo",
        arbitrary: true,
      }),
      false,
    );
    assert.match(
      renderToStaticMarkup(createElement(projects.component)),
      /Select a community to open a repository/,
    );
    await services.plugins.change("disable", "buzz.repos");
    // Bestie was re-enabled above, so it registered after Inbox.
    assert.deepEqual(
      services.pages.snapshot().map((page) => page.pluginId),
      ["buzz.channels", "buzz.agents", "buzz.inbox", "buzz.bestie"],
    );
    await services.plugins.change("enable", "buzz.repos");
    await vi.waitFor(() => {
      const restored = services.pages
        .snapshot()
        .find((page) => page.pluginId === "buzz.repos");
      assert.equal(restored?.pluginId, "buzz.repos");
      assert.notEqual(restored, projects);
    });
  } finally {
    await services?.dispose();
    await vite.close();
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }
  // A real Vite server, the whole service graph and every page render take
  // seconds alone, so the default budget expires under a parallel suite.
}, 30_000);
