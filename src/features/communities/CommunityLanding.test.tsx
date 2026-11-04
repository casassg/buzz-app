// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityLanding } from "./CommunityLanding";
import type { Communities } from "./service";
import { communityRequest, inspectProfile } from "./api";

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  communityRequest: vi
    .fn()
    .mockResolvedValue({ name: "Fixture", membershipRequired: true }),
  inspectProfile: vi
    .fn()
    .mockRejectedValue(new Error("Relay read failed (403)")),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const communities = {
  snapshot: () => ({
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "", about: "" },
    memberships: [],
    selected: null,
  }),
} as unknown as Communities;

function landing({
  hosted = false,
  invite = undefined as
    | { community: string; code: string; requestId: number }
    | undefined,
} = {}) {
  const props = {
    onInviteClose: vi.fn(),
    onJoined: vi.fn(),
    onCreate: vi.fn(),
  };
  render(
    <CommunityLanding
      communities={communities}
      invite={invite}
      settingsCards={{ subscribe: () => () => {}, has: () => hosted }}
      {...props}
    />,
  );
  return props;
}

it("opens the join steps from a pasted invite page link", async () => {
  const user = userEvent.setup();
  landing();
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Create a community" }),
  ).not.toBeInTheDocument();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example/invite/v2.invite",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("main");
  expect(dialog).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(await within(dialog).findByLabelText("Invite code")).toHaveValue(
    "v2.invite",
  );
  expect(
    within(dialog).queryByLabelText("Community URL"),
  ).not.toBeInTheDocument();
});

it("opens the join steps from a community address", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("main");
  expect(await within(dialog).findByLabelText("Invite code")).toBeVisible();
  expect(
    within(dialog).queryByLabelText("Community URL"),
  ).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Invite link or community URL")).toHaveValue(
    "https://relay.example",
  );
});

it("reads a bare host as a secure community address", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("main");
  expect(await within(dialog).findByLabelText("Invite code")).toHaveValue("");
  expect(communityRequest).toHaveBeenLastCalledWith(
    "https://relay.example",
    "info",
  );
});

it("asks for an invite link or community URL when the pasted value is neither", async () => {
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "not a link",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByText("Paste an invite link or community URL."),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("presents an opened invite and clears it on close", async () => {
  const user = userEvent.setup();
  const { onInviteClose } = landing({
    invite: { community: "https://relay.example", code: "x", requestId: 7 },
  });
  await screen.findByRole("main");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(onInviteClose).toHaveBeenCalledWith(7);
});

it("offers creating a community where hosting is available", async () => {
  const user = userEvent.setup();
  const { onCreate } = landing({ hosted: true });
  await user.click(screen.getByRole("button", { name: "Create a community" }));
  expect(onCreate).toHaveBeenCalledOnce();
});

it("lets a failed submitted lookup be corrected without losing the landing link", async () => {
  vi.mocked(communityRequest).mockRejectedValueOnce(
    new Error("Community unavailable"),
  );
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  const dialog = await screen.findByRole("main");
  expect(
    await within(dialog).findByText("Community unavailable"),
  ).toBeVisible();
  expect(within(dialog).getByLabelText("Community URL")).toHaveValue(
    "https://relay.example",
  );
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(await within(dialog).findByLabelText("Invite code")).toBeVisible();
});

it("omits invite entry when the access check succeeds and keeps policy links inline", async () => {
  vi.mocked(inspectProfile).mockResolvedValueOnce({
    exists: false,
    existing: {},
    profile: { name: "", picture: "", about: "" },
  });
  vi.mocked(communityRequest).mockResolvedValueOnce({
    name: "Open community",
    policy: {
      version: "1",
      terms_markdown: "Terms",
      privacy_markdown: "Privacy",
      age_attestation_required: false,
    },
  });
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Open community")).toBeVisible();
  expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Terms of Service" }),
  ).toHaveAttribute("href", "https://relay.example/api/join-policy/terms");
  expect(screen.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute(
    "href",
    "https://relay.example/api/join-policy/privacy",
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
});

it("does not infer an invite requirement from denied access on an open relay", async () => {
  vi.mocked(communityRequest).mockResolvedValueOnce({
    name: "Open community",
    membershipRequired: false,
    policy: null,
  });
  vi.mocked(inspectProfile).mockRejectedValueOnce(
    new Error("Relay read failed (403)"),
  );
  const user = userEvent.setup();
  landing();
  await user.type(
    screen.getByLabelText("Invite link or community URL"),
    "https://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Open community")).toBeVisible();
  expect(screen.queryByLabelText("Invite code")).not.toBeInTheDocument();
});
