import voiceNotesManifest from "./voice-notes/manifest.json";
import * as voiceNotes from "./voice-notes";
import pairingManifest from "./pairing/manifest.json";
import * as pairing from "./pairing";
import todosManifest from "./todos/manifest.json";
import huddlesManifest from "./huddles/manifest.json";
import * as huddles from "./huddles";
import builderlabManifest from "./builderlab/manifest.json";
import * as builderlab from "./builderlab";
import * as todos from "./todos";
import diffsManifest from "./diffs/manifest.json";
import * as diffs from "./diffs";
import mermaidManifest from "./mermaid/manifest.json";
import * as mermaid from "./mermaid";
import namingManifest from "./identity-naming/manifest.json";
import * as naming from "./identity-naming";
import feedbackManifest from "./feedback/manifest.json";
import * as feedback from "./feedback";
import activityManifest from "./agent-activity/manifest.json";
import * as activity from "./agent-activity";
import terminalManifest from "./terminal/manifest.json";
import * as terminal from "./terminal";
import profilesManifest from "./profiles/manifest.json";
import * as profiles from "./profiles";
import agentsManifest from "./agents/manifest.json";
import * as agents from "./agents";
import watchingManifest from "./watching/manifest.json";
import * as watching from "./watching";
import claudeCodeManifest from "./claude-code/manifest.json";
import * as claudeCode from "./claude-code";
import codexManifest from "./codex/manifest.json";
import * as codex from "./codex";
import gooseManifest from "./goose/manifest.json";
import * as goose from "./goose";
import opencodeManifest from "./opencode/manifest.json";
import * as opencode from "./opencode";
import piManifest from "./pi/manifest.json";
import * as pi from "./pi";
import channelsManifest from "./channels/manifest.json";
import githubManifest from "./github/manifest.json";
import * as channels from "./channels";
import * as github from "./github";
import bestieManifest from "./bestie/manifest.json";
import * as bestie from "./bestie";
import usageManifest from "./usage/manifest.json";
import * as usage from "./usage";
import inboxManifest from "./inbox/manifest.json";
import * as inbox from "./inbox";
import focusManifest from "./focus/manifest.json";
import * as focus from "./focus";
import remindersManifest from "./reminders/manifest.json";
import * as reminders from "./reminders";
import reposManifest from "./repos/manifest.json";
import * as repos from "./repos";
import workflowsManifest from "./workflows/manifest.json";
import * as workflows from "./workflows";
import type { BundledPlugin } from "../plugins/manager";
import linksManifest from "./links/manifest.json";
import * as links from "./links";
import moderationManifest from "./moderation/manifest.json";
import * as moderation from "./moderation";
import relayStaffManifest from "./relay-staff/manifest.json";
import * as relayStaff from "./relay-staff";
import typesafeManifest from "./typesafe/manifest.json";
import * as typesafe from "./typesafe";
import pluginDevelopmentManifest from "./plugin-development/manifest.json";
import * as pluginDevelopment from "./plugin-development";

import relayNotesManifest from "./relay-notes/manifest.json";
import * as relayNotes from "./relay-notes";

export const bundledPlugins: readonly BundledPlugin[] = [
  {
    manifest: { ...relayNotesManifest, apiVersion: 1 },
    module: relayNotes,
    enabledByDefault: false,
  },
  {
    manifest: { ...huddlesManifest, apiVersion: 1 },
    module: huddles,
    enabledByDefault: true,
  },
  {
    manifest: { ...voiceNotesManifest, apiVersion: 1 },
    module: voiceNotes,
    enabledByDefault: true,
  },
  {
    manifest: { ...builderlabManifest, apiVersion: 1 },
    module: builderlab,
    enabledByDefault: true,
  },
  {
    manifest: { ...pairingManifest, apiVersion: 1 },
    module: pairing,
    enabledByDefault: true,
  },
  {
    manifest: { ...feedbackManifest, apiVersion: 1 },
    module: feedback,
    enabledByDefault: true,
  },
  {
    manifest: { ...todosManifest, apiVersion: 1 },
    module: todos,
    enabledByDefault: false,
  },
  {
    manifest: { ...diffsManifest, apiVersion: 1 },
    module: diffs,
    enabledByDefault: true,
  },
  {
    manifest: { ...mermaidManifest, apiVersion: 1 },
    module: mermaid,
    enabledByDefault: true,
  },
  {
    manifest: { ...namingManifest, apiVersion: 1 },
    module: naming,
    enabledByDefault: true,
  },
  {
    manifest: { ...activityManifest, apiVersion: 1 },
    module: activity,
    enabledByDefault: true,
  },
  {
    manifest: { ...terminalManifest, apiVersion: 1 },
    module: terminal,
    enabledByDefault: true,
  },
  {
    manifest: { ...profilesManifest, apiVersion: 1 },
    module: profiles,
    enabledByDefault: true,
  },
  {
    manifest: { ...linksManifest, apiVersion: 1 },
    module: links,
    enabledByDefault: true,
  },
  {
    manifest: { ...channelsManifest, apiVersion: 1 },
    module: channels,
    enabledByDefault: true,
  },
  {
    manifest: { ...githubManifest, apiVersion: 1 },
    module: github,
    enabledByDefault: true,
  },
  {
    manifest: { ...bestieManifest, apiVersion: 1 },
    module: bestie,
    enabledByDefault: false,
  },
  {
    manifest: { ...usageManifest, apiVersion: 1 },
    module: usage,
    enabledByDefault: false,
  },
  {
    manifest: { ...inboxManifest, apiVersion: 1 },
    module: inbox,
    enabledByDefault: true,
  },
  {
    manifest: { ...remindersManifest, apiVersion: 1 },
    module: reminders,
    enabledByDefault: false,
  },
  {
    manifest: { ...focusManifest, apiVersion: 1 },
    module: focus,
    enabledByDefault: false,
  },
  {
    manifest: { ...reposManifest, apiVersion: 1 },
    module: repos,
    enabledByDefault: true,
  },
  {
    manifest: { ...agentsManifest, apiVersion: 1 },
    module: agents,
    enabledByDefault: true,
  },
  {
    manifest: { ...watchingManifest, apiVersion: 1 },
    module: watching,
    enabledByDefault: true,
  },
  {
    manifest: { ...claudeCodeManifest, apiVersion: 1 },
    module: claudeCode,
    enabledByDefault: true,
  },
  {
    manifest: { ...codexManifest, apiVersion: 1 },
    module: codex,
    enabledByDefault: true,
  },
  {
    manifest: { ...gooseManifest, apiVersion: 1 },
    module: goose,
    enabledByDefault: true,
  },
  {
    manifest: { ...opencodeManifest, apiVersion: 1 },
    module: opencode,
    enabledByDefault: false,
  },
  {
    manifest: { ...piManifest, apiVersion: 1 },
    module: pi,
    enabledByDefault: false,
  },
  {
    manifest: { ...workflowsManifest, apiVersion: 1 },
    module: workflows,
    enabledByDefault: false,
  },
  {
    manifest: { ...moderationManifest, apiVersion: 1 },
    module: moderation,
    enabledByDefault: true,
  },
  {
    manifest: { ...relayStaffManifest, apiVersion: 1 },
    module: relayStaff,
    enabledByDefault: true,
  },
  {
    manifest: { ...typesafeManifest, apiVersion: 1 },
    module: typesafe,
    enabledByDefault: true,
  },
  {
    manifest: { ...pluginDevelopmentManifest, apiVersion: 1 },
    module: pluginDevelopment,
    enabledByDefault: true,
  },
];
