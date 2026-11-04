import { expect, it } from "vitest";
import { parseInviteLink, parsePastedInvite } from "./invite-link";

it.each(["", "/"])(
  "parses the join form with path %j and canonicalizes the relay",
  (path) => {
    expect(
      parseInviteLink(
        `buzz://join${path}?relay=wss%3A%2F%2Frelay.example%2F&code=v2.invite&policy_receipt=receipt`,
      ),
    ).toEqual({
      community: "https://relay.example",
      code: "v2.invite",
    });
  },
);
it.each([
  "buzz://connect?relay=wss%3A%2F%2Frelay.example%2F&code=ignored",
  "buzz://connect/?relay=wss%3A%2F%2Frelay.example",
  "buzz://add-community?relay=wss%3A%2F%2Frelay.example%2F&name=relay",
  "buzz://add-community/?relay=wss%3A%2F%2Frelay.example",
])("parses the code-less community link %s", (url) => {
  expect(parseInviteLink(url)).toEqual({
    community: "https://relay.example",
    code: "",
  });
});
it.each([
  "buzz://connect?relay=ws%3A%2F%2Frelay.example",
  "buzz://connect?relay=wss%3A%2F%2Frelay.example&relay=wss%3A%2F%2Fother.example",
  "buzz://connect/extra?relay=wss%3A%2F%2Frelay.example",
  "buzz://connect?code=x",
  "buzz://add-community?relay=ws%3A%2F%2Frelay.example",
  "buzz://join?relay=example&code=x",
  "buzz://join?relay=wss%3A%2F%2Fuser%40relay.example&code=x",
  "buzz://join?relay=wss%3A%2F%2Frelay.example%2Fother&code=x",
  "https://relay.example/invite/x?redirect=evil",
])("rejects an unsafe or ambiguous invite: %s", (url) => {
  expect(parseInviteLink(url)).toBeNull();
});

it.each(["", "/"])("keeps invite validation with path %j", (path) => {
  const query = "relay=wss%3A%2F%2Frelay.example&code=v2.invite";
  for (const url of [
    `buzz://join${path}?${query}&code=other`,
    `buzz://join${path}?${query}&relay=wss%3A%2F%2Fother.example`,
    `buzz://join${path}?${query}&policy_receipt=`,
    `buzz://join${path}?${query}&policy_receipt=x&policy_receipt=y`,
    `buzz://join${path}?${query}#fragment`,
    `buzz://join:443${path}?${query}`,
    `buzz://user@join${path}?${query}`,
    `buzz://join${path}?relay=ws%3A%2F%2Frelay.example&code=x`,
    `buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=`,
  ])
    expect(parseInviteLink(url), url).toBeNull();
});
it.each(["//", "/extra", "/%2F", "/./", "/extra/.."])(
  "rejects noncanonical invite path %j",
  (path) => {
    expect(
      parseInviteLink(
        `buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=x`,
      ),
    ).toBeNull();
  },
);

it.each([
  [
    "https://relay.example/invite/v2.invite",
    { community: "https://relay.example", code: "v2.invite" },
  ],
  [
    "  https://relay.example/invite/v2%2Binvite/ ",
    { community: "https://relay.example", code: "v2+invite" },
  ],
  [
    "buzz://join?relay=wss%3A%2F%2Frelay.example&code=v2.invite",
    { community: "https://relay.example", code: "v2.invite" },
  ],
  ["wss://relay.example", { community: "https://relay.example", code: "" }],
  // A typed address may omit its scheme, as in the native first-run field.
  ["relay.example", { community: "https://relay.example", code: "" }],
  [
    " Relay.Example.com:8443 ",
    { community: "https://relay.example.com:8443", code: "" },
  ],
  ["localhost:3000", { community: "https://localhost:3000", code: "" }],
  // A bare invite code with a dot reads as a host, so it fails at lookup.
  ["v2.invite", { community: "https://v2.invite", code: "" }],
])("reads a pasted invite or address: %s", (input, expected) => {
  expect(parsePastedInvite(input)).toEqual(expected);
});

it.each([
  "",
  "not a relay",
  "ws://relay.example",
  "http://relay.example",
  "wss://user:pass@relay.example",
  "user@relay.example",
  "relay.example/invite/x",
  "relay.example?x=1",
  "relay.example#x",
  "http://relay.example/invite/x",
  "https://user@relay.example/invite/x",
  "https://relay.example/invite/x?redirect=evil",
  "https://relay.example/invite/x#fragment",
  "https://relay.example/invite/x/extra",
  "https://relay.example/other",
  "https://relay.example/invite/%E0%A4%A",
  `https://relay.example/invite/${"x".repeat(257)}`,
])("rejects a pasted value that is not an invite: %j", (input) => {
  expect(parsePastedInvite(input)).toBeNull();
});
