import type { PluginModule } from "../../plugins/api";
import { isApplePlatform } from "../../features/shortcuts/format";
import { InboxPage, type ArchiveShortcut } from "./InboxPage";
import { inboxRouteTarget, isInboxRoute, type InboxRoute } from "./route";
import { InboxBadge } from "./InboxBadge";
export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "panels",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  const archive: ArchiveShortcut = {};
  ctx.shortcuts.register({
    id: "archive-conversation",
    title: "Archive or restore conversation",
    // Solo's Archive chat chord: Apple Mail's Archive, and Ctrl+Shift+E elsewhere.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 10,
    allowInEditable: true,
    when: () => !!archive.current,
    run: () => archive.current?.(),
  });
  // Slack's chords for jumping to a filtered Inbox, including from the composer.
  const open = (
    id: string,
    title: string,
    key: string,
    order: number,
    params: InboxRoute,
  ) =>
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, mod: true, shift: true },
      order,
      allowInEditable: true,
      run: () => {
        void navigator.open(inboxRouteTarget(params));
      },
    });
  open("open-unread", "Open unread in Inbox", "a", 20, {
    activity: "all",
    attention: "unread",
  });
  open("open-threads", "Open threads in Inbox", "t", 30, {
    activity: "threads",
  });
  open("open-mentions", "Open mentions in Inbox", "m", 40, {
    activity: "mentions",
  });
  open("open-dms", "Open DMs in Inbox", "k", 50, { activity: "dms" });
  ctx.pages.register({
    id: "inbox",
    title: "Inbox",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: isInboxRoute },
    badge: () => <InboxBadge relay={relay} />,
    component: ({ navigation }) => (
      <InboxPage
        host={ctx}
        relay={relay}
        navigator={navigator}
        extensions={ctx.conversation}
        tabs={ctx.conversation.ui.Tabs}
        archive={archive}
        navigation={navigation}
      />
    ),
  });
};
