// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateModelChoices } from "../../features/agents/CreateModelChoices";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { agentAvatars } from "../../features/agents/avatar-packs";
import type {
  Agent,
  AgentCreateProps,
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  emojiAvatar,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { AgentCreateDialog } from "./AgentCreateDialog";
import {
  BuilderlabLogoIcon,
  CodexLogoIcon,
} from "../../shared/design-system/icons";
import { Select } from "../../shared/design-system/ui/Select";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  uploadAvatar: vi.fn(),
  emojiAvatar: vi.fn(),
  paintEmojiAvatar: vi.fn(),
}));

// Exercise our selection callback without emoji-mart's browser-only observers.
vi.mock("../../bundled/emoji/emoji-mart", () => ({
  mountEmojiMart: ({
    host,
    select,
  }: {
    host: HTMLElement;
    select(value: string): void;
  }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Choose robot";
    button.onclick = () => select("🤖");
    host.append(button);
    return () => button.remove();
  },
}));

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

afterEach(cleanup);
// jsdom has no object URLs; an upload previews its file through one.
beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:upload"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
// jsdom lacks both; tests that need them install stubs, removed here along
// with stubbed frames and media queries.
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
  motion.reduced = false;
});

type Echo = { reply: string };
type Notes = { notes: string; instructions: string };

const echo = {
  key: "test/echo",
  pluginId: "test",
  revision: "1",
  id: "echo",
  title: "Echo",
  description: "Says its line.",
  defaults: () => ({ config: { reply: "" } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Echo;
    disabled: boolean;
    onChange(config: Echo): void;
  }) => (
    <input
      aria-label="Reply"
      disabled={disabled}
      value={config.reply}
      onChange={(event) => onChange({ reply: event.target.value })}
    />
  ),
} as unknown as RegisteredAgentType;

const notes = {
  key: "test/notes",
  pluginId: "test",
  revision: "1",
  id: "notes",
  title: "Notes",
  description: "Takes notes.",
  defaults: () => ({ config: { notes: "start", instructions: "Be brief." } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Notes;
    disabled: boolean;
    onChange(config: Notes): void;
  }) => (
    <>
      <input
        aria-label="Notes"
        disabled={disabled}
        value={config.notes}
        onChange={(event) => onChange({ ...config, notes: event.target.value })}
      />
      <AgentInstructions
        value={config.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...config, instructions })}
      />
    </>
  ),
} as unknown as RegisteredAgentType;

const made = {
  pubkey: "3".repeat(64),
  name: "Nova",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attention: {},
} as unknown as Agent;

function setup(
  types: readonly RegisteredAgentType[],
  create: (input: NewAgent) => Promise<Agent> = async () => made,
  community?: string,
) {
  const agents = { create: vi.fn(create) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentCreateDialog
      agents={agents}
      types={types}
      community={community}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  return { agents, onCreated, onClose, dialog, user: userEvent.setup() };
}

const createButton = () => screen.getByRole("button", { name: "Create agent" });

it("creates with the name, a pack picture and the config from the type's view", async () => {
  const { agents, onCreated, dialog, user } = setup([echo]);
  expect(
    within(dialog).queryByRole("combobox", { name: "Thinking" }),
  ).toBeNull();
  await user.type(within(dialog).getByLabelText("Name"), "  Nova ");

  const grid = within(dialog).getByRole("group", { name: "Agent avatars" });
  const avatar = agentAvatars.find((item) =>
    within(grid).queryByRole("button", { name: item.label }),
  );
  const previous = agentAvatars.find(
    (item) => !within(grid).queryByRole("button", { name: item.label }),
  );
  if (!avatar || !previous)
    throw new Error("The preview and dock have avatars");
  const slot = within(grid).getByRole("button", { name: avatar.label });
  await user.click(slot);
  expect(
    within(grid).queryByRole("button", { name: avatar.label }),
  ).not.toBeInTheDocument();
  expect(slot).toHaveAccessibleName(previous.label);
  expect(await within(dialog).findByLabelText("Name")).toHaveValue("  Nova ");
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/echo",
    name: "Nova",
    picture: avatar.url,
    config: { reply: "Hi there" },
  });
  expect(avatar.url).toMatch(/^https:\/\//);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(made);
});

it("cancels an in-flight Gloopy swap before switching to Emoji", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("(hover: hover)"),
    addEventListener() {},
    removeEventListener() {},
  }));
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    finished: Promise<void>;
  }[] = [];
  Element.prototype.animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(),
      finished: new Promise<void>(() => {}),
    };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  const { dialog, user } = setup([echo]);
  const dock = within(dialog).getByRole("group", { name: "Agent avatars" });
  const slot = within(dock).getAllByRole("button")[0];
  if (!slot) throw new Error("The dock has an avatar");
  fireEvent.click(slot, { detail: 1 });
  expect(animations).toHaveLength(2);
  const swapAnimations = [...animations];
  expect(slot.style.visibility).toBe("hidden");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(
    within(dialog).getByRole("button", { name: "Choose emoji" }),
  ).toBeVisible();
  for (const animation of swapAnimations)
    expect(animation.cancel).toHaveBeenCalledOnce();
  expect(slot.style.visibility).toBe("");
  expect(document.querySelector('body > img[aria-hidden="true"]')).toBeNull();
});

it("switches avatar types directly and restores the emoji draft with the keyboard", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  const tabs = within(
    within(dialog).getByRole("tablist", { name: "Avatar type" }),
  );
  expect(tabs.getAllByRole("tab")).toHaveLength(3);
  expect(tabs.getByRole("tab", { name: "Gloopies" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(tabs.getByRole("tab", { name: "Emoji" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(tabs.getByRole("tab", { name: "Gloopies" }));
  await user.keyboard("{ArrowRight}{Enter}");
  expect(tabs.getByRole("tab", { name: "Emoji" })).toHaveFocus();
  expect(tabs.getByRole("tab", { name: "Emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("creates with a custom emoji on a chosen background", async () => {
  const file = new File(["emoji"], "avatar.png", { type: "image/png" });
  vi.mocked(emojiAvatar).mockResolvedValueOnce(file);
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://images.example/emoji.png",
  );
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(within(dialog).getByRole("tab", { name: "Emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Choose emoji" }),
  );
  await user.click(await screen.findByRole("button", { name: "Choose robot" }));
  expect(
    screen.queryByRole("button", { name: "Choose robot" }),
  ).not.toBeInTheDocument();
  expect(
    within(
      within(dialog).getByRole("group", { name: "Avatar background" }),
    ).getAllByRole("button"),
  ).toHaveLength(20);
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(createButton());
  expect(emojiAvatar).toHaveBeenCalledExactlyOnceWith("🤖", "#0090FF");
  await waitFor(() =>
    expect(uploadAvatar).toHaveBeenCalledWith(
      file,
      "https://a.example",
      expect.any(AbortSignal),
    ),
  );
  expect(agents.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ picture: "https://images.example/emoji.png" }),
  );
});

it("keeps an emoji avatar draft after an outside click", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  );
  await user.click(document.body);
  expect(dialog).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Use #0090FF background" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("does not create an emoji avatar without an upload community", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(createButton());
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Select a community",
  );
  expect(agents.create).not.toHaveBeenCalled();
  expect(createButton()).toBeEnabled();
});

it("opens the file picker directly and recovers from an upload failure", async () => {
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const input = within(dialog).getByLabelText(
    "Upload an image",
  ) as HTMLInputElement;
  const browse = vi.spyOn(input, "click");
  await user.click(within(dialog).getByRole("tab", { name: "Upload image" }));
  expect(browse).toHaveBeenCalledOnce();
  vi.mocked(uploadAvatar).mockRejectedValueOnce(new Error("Upload failed"));
  const file = new File(["image"], "image.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Upload failed",
  );
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://images.example/upload.png",
  );
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument(),
  );
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ picture: "https://images.example/upload.png" }),
  );
});

it("previews an upload in place with progress and cancel, keeping Name editable", async () => {
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  let report: (sent: number, total: number) => void = () => {};
  let signal: AbortSignal | undefined;
  vi.mocked(uploadAvatar).mockImplementationOnce(
    (_file, _community, abort, progress) => {
      signal = abort;
      report = progress ?? report;
      return new Promise<string>(() => {});
    },
  );
  const file = new File(["image"], "image.png", { type: "image/png" });
  fireEvent.change(within(dialog).getByLabelText("Upload an image"), {
    target: { files: [file] },
  });
  expect(
    await within(dialog).findByRole("img", { name: "Uploading avatar" }),
  ).toBeInTheDocument();
  expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  const ring = within(dialog).getByRole("progressbar", {
    name: "Uploading image",
  });
  expect(ring).not.toHaveAttribute("aria-valuenow");
  act(() => report(1, 4));
  expect(ring).toHaveAttribute("aria-valuenow", "25");
  for (const tab of within(dialog).getAllByRole("tab"))
    expect(tab).toHaveAttribute("aria-disabled", "true");
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  expect(
    within(dialog).queryByRole("button", { name: "Choose emoji" }),
  ).not.toBeInTheDocument();
  // Only Create waits on the upload.
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(createButton()).toBeDisabled();

  await user.click(
    within(dialog).getByRole("button", { name: "Cancel upload" }),
  );
  expect(signal?.aborted).toBe(true);
  for (const tab of within(dialog).getAllByRole("tab"))
    expect(tab).not.toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:upload");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Nova",
      picture: expect.not.stringContaining("blob:"),
    }),
  );
});

it("keeps every bundled avatar available after switching from an uploaded image", async () => {
  const { dialog, user } = setup([echo], undefined, "https://a.example");
  const dock = within(dialog).getByRole("group", { name: "Agent avatars" });
  const initial = agentAvatars.find(
    (avatar) => !within(dock).queryByRole("button", { name: avatar.label }),
  );
  if (!initial) throw new Error("The selected avatar is outside the dock");
  const input = within(dialog).getByLabelText("Upload an image");
  for (let attempt = 0; attempt < 2; attempt++) {
    vi.mocked(uploadAvatar).mockResolvedValueOnce(
      "https://images.example/upload.png",
    );
    fireEvent.change(input, {
      target: {
        files: [new File(["image"], "image.png", { type: "image/png" })],
      },
    });
    await waitFor(() =>
      expect(within(dialog).queryByRole("status")).not.toBeInTheDocument(),
    );
    const choice = within(dock)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-label") !== initial.label);
    if (!choice) throw new Error("Another bundled avatar is available");
    await user.click(choice);
    expect(within(dock).getAllByRole("button")).toHaveLength(
      agentAvatars.length - 1,
    );
  }
  expect(
    within(dock).getByRole("button", { name: initial.label }),
  ).toBeEnabled();
  await user.click(within(dock).getByRole("button", { name: initial.label }));
  expect(
    within(dock).queryByRole("button", { name: initial.label }),
  ).not.toBeInTheDocument();
});

it("opens on the name field", async () => {
  const { dialog } = setup([echo]);
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveFocus(),
  );
});

it("starts with a pack picture already chosen", async () => {
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  const [input] = agents.create.mock.calls[0] as [NewAgent];
  expect(input.picture).toMatch(/^https:\/\//);
  expect(agentAvatars.map((avatar) => avatar.url)).toContain(input.picture);
});

it("shows the sole harness as a disabled choice", async () => {
  const { dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(screen.getByRole("combobox", { name: "Harness" })).toBeDisabled();
});

it("flags an empty name on Create and clears it once named", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const animate = vi.fn();
  Element.prototype.animate = animate;
  const { agents, dialog, user } = setup([echo]);
  const name = () => within(dialog).getByLabelText("Name");
  const alert = () => within(dialog).queryByRole("alert");
  expect(createButton()).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Next" }),
  ).not.toBeInTheDocument();
  expect(alert()).not.toBeInTheDocument();
  await user.type(name(), "   ");
  await user.click(createButton());
  expect(agents.create).not.toHaveBeenCalled();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(name()).toHaveAccessibleDescription("Add a name to create your agent");
  expect(name()).toHaveAttribute("placeholder", "Name");
  expect(name()).toHaveAttribute("aria-invalid", "true");
  expect(name()).toHaveFocus();
  // Already in view, so nothing scrolls.
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(animate).toHaveBeenCalledOnce();
  expect(name()).toHaveValue("   ");
  // Each further empty submit shakes again.
  await user.click(createButton());
  expect(animate).toHaveBeenCalledTimes(2);
  expect(agents.create).not.toHaveBeenCalled();
  await user.type(name(), "Nova");
  expect(alert()).not.toBeInTheDocument();
  expect(name()).not.toHaveAttribute("aria-invalid");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledOnce();
});

/** Hands each animation frame to the test, so it can step a scroll. */
const stepFrames = () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) =>
    frames.push(frame),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // One tick runs every frame requested before it, like the browser.
  return () =>
    act(() => {
      for (const frame of frames.splice(0)) frame(performance.now());
    });
};

/** An out-of-view name whose position the test moves frame by frame. */
const scrolledName = (dialog: HTMLElement) => {
  const name = within(dialog).getByLabelText("Name");
  // Just below the fold.
  const position = { top: window.innerHeight - 38 };
  name.getBoundingClientRect = () =>
    ({ top: position.top, bottom: position.top + 40 }) as DOMRect;
  const scrollIntoView = vi.fn();
  name.scrollIntoView = scrollIntoView;
  return { name, position, scrollIntoView };
};

it("scrolls an out-of-view name to center, then flags it as the glide slows", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog, user } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  const alert = () => within(dialog).queryByRole("alert");
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "center",
    behavior: "smooth",
  });
  // Pressing again mid-scroll doesn't start a second scroll.
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledOnce();
  step();
  // Easing in: barely moving, and just in view, but not yet past the glide.
  position.top = window.innerHeight - 41;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 600;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 300;
  step();
  expect(alert()).not.toBeInTheDocument();
  // In view and slowing: the prompt plays while the glide lands.
  position.top = 298;
  step();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(Element.prototype.animate).toHaveBeenCalledOnce();
});

it("does not flag a name typed while it scrolls into view", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog, user } = setup([echo]);
  const { name, position } = scrolledName(dialog);
  await user.click(createButton());
  step();
  fireEvent.change(name, { target: { value: "Nova" } });
  position.top = 300;
  step();
  position.top = 300;
  step();
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(Element.prototype.animate).not.toHaveBeenCalled();
});

it("jumps instead of gliding, and skips the shake, under reduced motion", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  }));
  motion.reduced = true;
  const { dialog, user } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledWith(
    expect.objectContaining({ behavior: "auto" }),
  );
  position.top = 300;
  step();
  step();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Add a name to create your agent",
  );
  expect(Element.prototype.animate).not.toHaveBeenCalled();
});

it("shows registered logos in the harness value and choices with independent SVG masks", async () => {
  const { dialog, user } = setup([
    { ...echo, icon: BuilderlabLogoIcon },
    { ...notes, icon: CodexLogoIcon },
  ]);
  const select = within(dialog).getByRole("combobox", { name: "Harness" });
  const selectedMask = select.querySelector("mask");
  expect(selectedMask).not.toBeNull();
  await user.click(select);
  const option = await screen.findByRole("option", { name: "Echo" });
  const optionMask = option.querySelector("mask");
  expect(optionMask).not.toBeNull();
  expect(optionMask?.id).not.toBe(selectedMask?.id);
  for (const svg of [
    select.querySelector("svg"),
    option.querySelector("svg"),
  ]) {
    const mask = svg?.querySelector("mask");
    expect(svg?.querySelector("path[mask]")).toHaveAttribute(
      "mask",
      `url(#${mask?.id})`,
    );
    const filter = svg?.querySelector("filter");
    expect(mask?.querySelector("path")).toHaveAttribute(
      "filter",
      `url(#${filter?.id})`,
    );
  }
  const other = screen.getByRole("option", { name: "Notes" });
  expect(other.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  await user.click(other);
  expect(select).toHaveTextContent("Notes");
  expect(select.querySelector("svg")).not.toBeNull();
  expect(select.querySelector("mask")).toBeNull();
});

it("switches harness, starting over on the new type's defaults", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.type(within(dialog).getByLabelText("Reply"), "typed in echo");
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Notes" }));

  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Reply")).not.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Notes")).toHaveValue("start");
  // The name stays; only the type's own settings start over.
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/notes",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { notes: "start", instructions: "Be brief." },
  });
});

it("starts over again when switching back to the first type", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.type(within(dialog).getByLabelText("Reply"), "typed");
  const switchTo = async (to: string) => {
    await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
    await user.click(await screen.findByRole("option", { name: to }));
  };
  await switchTo("Notes");
  await switchTo("Echo");
  expect(within(dialog).getByLabelText("Reply")).toHaveValue("");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

it("edits instructions directly without a separate editing step", async () => {
  const { agents, dialog, user } = setup([notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  expect(
    within(dialog).getByRole("form", { name: "New agent" }),
  ).toContainElement(instructions);
  await user.type(instructions, " And kind.{Enter}Keep it short.");
  expect(agents.create).not.toHaveBeenCalled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        notes: "start",
        instructions: "Be brief. And kind.\nKeep it short.",
      },
    }),
  );
});

it("shows a failed create's error in view, stays open, and lets it be tried again", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  let attempts = 0;
  const { agents, onCreated, onClose, dialog, user } = setup(
    [echo],
    async () => {
      if (++attempts === 1) throw new Error("Credential store refused");
      return made;
    },
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Credential store refused");
  // Below a long form, the error would otherwise be out of sight.
  expect(scrollIntoView.mock.contexts).toEqual([alert]);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  expect(createButton()).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a shown error when the name changes", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const { dialog, user } = setup([echo], async () => {
    throw new Error("Nope");
  });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  await user.type(within(dialog).getByLabelText("Name"), "!");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks a second create while the first is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [echo],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalledTimes(1));
  expect(within(dialog).getByLabelText("Name")).toBeDisabled();
  expect(within(dialog).getByLabelText("Reply")).toBeDisabled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(1);
  finish(made);
});

const withModels = (type: RegisteredAgentType): RegisteredAgentType => ({
  ...type,
  CreateModel: ({ config, onChange, ...props }) => {
    const current = config as Record<string, unknown>;
    return (
      <CreateModelChoices
        {...props}
        models={[
          { id: "fast", label: "Fast" },
          { id: "deep", label: "Deep" },
        ]}
        value={String(current.model ?? "")}
        defaultLabel={`${type.title} default`}
        onChange={(model) => onChange({ ...current, model })}
      />
    );
  },
});

const withThinking = (type: RegisteredAgentType): RegisteredAgentType =>
  ({
    ...type,
    defaults: () => ({
      config: { notes: "start", instructions: "Be brief.", effort: "" },
    }),
    CreateThinking: ({ config, disabled, onChange }: AgentCreateProps) => {
      const current = config as Record<string, unknown>;
      return (
        <Select
          label="Thinking"
          value={String(current.effort ?? "")}
          variant="compact"
          disabled={disabled}
          groups={[
            {
              label: "",
              options: [
                { value: "", label: "Automatic · Default" },
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          ]}
          onValueChange={(effort) => onChange({ ...current, effort })}
        />
      );
    },
  }) as unknown as RegisteredAgentType;

it("saves the create-time Thinking choice in the initial agent config", async () => {
  const { agents, dialog, user } = setup([withThinking(notes)]);
  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");

  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(thinking);
  const high = await screen.findByRole("option", { name: "High" });
  await waitFor(() =>
    expect(
      screen.getByRole("option", { name: "Automatic · Default" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(high).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.click(createButton());

  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/notes",
      config: { notes: "start", instructions: "Be brief.", effort: "high" },
    }),
  );
});

it("restores inherited Thinking when Default is chosen before creation", async () => {
  const { agents, dialog, user } = setup([withThinking(notes)]);
  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  expect(thinking).toHaveTextContent("High");
  await user.click(thinking);
  await user.click(
    await screen.findByRole("option", { name: "Automatic · Default" }),
  );
  expect(thinking).toHaveTextContent("Automatic · Default");

  await user.click(createButton());

  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/notes",
      config: { notes: "start", instructions: "Be brief.", effort: "" },
    }),
  );
});

it("drops the provider-specific Thinking choice when changing harnesses", async () => {
  const { agents, dialog, user } = setup([withThinking(notes), echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));

  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Echo" }));
  expect(
    within(dialog).queryByRole("combobox", { name: "Thinking" }),
  ).toBeNull();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

it("disables the Thinking control while creation is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [withThinking(notes)],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  try {
    await user.click(createButton());
    await waitFor(() => expect(agents.create).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("combobox", { name: "Thinking" }),
    ).toBeDisabled();
  } finally {
    finish(made);
  }
});

it("keeps typed instructions when choosing a harness or model", async () => {
  // Both types carry instructions, as the bundled harnesses do.
  const carrying = (key: string, title: string): RegisteredAgentType => ({
    ...withModels(notes),
    key,
    title,
    carry: (config) => ({ instructions: (config as Notes).instructions }),
    adopt: (carry, config) => ({
      ...(config as Notes),
      instructions: carry.instructions ?? (config as Notes).instructions,
    }),
  });
  const { agents, dialog, user } = setup([
    carrying("test/notes", "Notes"),
    carrying("test/other", "Other"),
  ]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByLabelText("Instructions");
  await user.clear(instructions);
  await user.type(instructions, "Keep this.");
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "Keep this.",
  );
  await user.click(within(dialog).getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Deep" }));
  expect(within(dialog).getByLabelText("Instructions")).toHaveValue(
    "Keep this.",
  );
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "test/other",
      config: { notes: "start", instructions: "Keep this.", model: "deep" },
    }),
  );
});

it("submits custom creation instructions and disables editing while saving", async () => {
  let finish: (agent: Agent) => void = () => {};
  const creationType: RegisteredAgentType = {
    ...withModels(notes),
    Create: ({ config, disabled, onChange }) => {
      const current = config as Notes;
      return (
        <AgentInstructions
          creation
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
      );
    },
  };
  const { agents, onCreated, dialog, user } = setup(
    [creationType],
    () =>
      new Promise<Agent>((resolve) => {
        finish = resolve;
      }),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions Optional",
  });
  expect(
    within(dialog).queryByRole("group", { name: "Instruction presets" }),
  ).not.toBeInTheDocument();
  await user.clear(instructions);
  await user.type(instructions, "Build accessible tools for my team.");
  try {
    await user.click(createButton());
    await waitFor(() => expect(agents.create).toHaveBeenCalledOnce());
    expect(instructions).toBeDisabled();

    expect(agents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          notes: "start",
          instructions: "Build accessible tools for my team.",
        },
      }),
    );
  } finally {
    finish(made);
  }
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
});

it("preserves the existing avatar and requested name when saving a proposed update", async () => {
  const agents = { create: vi.fn() } as unknown as Agents;
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCreated = vi.fn();
  const agent = {
    ...made,
    picture: "https://example.test/existing.png",
    config: { reply: "kept" },
  };
  render(
    <AgentCreateDialog
      agents={agents}
      types={[echo]}
      onClose={vi.fn()}
      onCreated={onCreated}
      update={{
        agent,
        onSave,
        request: {
          id: "request",
          requester: "requester",
          requesterName: "Ada",
          owner: made.owner,
          community: "here",
          agent: made.pubkey,
          agentName: made.name,
          agentType: made.type,
          name: "Requested name",
        },
      }}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Requested name",
  );
  expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("kept");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      type: made.type,
      name: "Requested name",
      picture: agent.picture,
      config: { reply: "kept" },
    }),
  );
  expect(agents.create).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});
