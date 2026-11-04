import { communityDestination, enteredRelayOrigin } from "./destination";

export type InviteLink = Readonly<{
  community: string;
  code: string;
}>;

/** Parse a relay invite (`buzz://join`) or a code-less community link
 * (`buzz://connect`, `buzz://add-community`) without treating its URL as
 * authority to join. */
export function parseInviteLink(input: string): InviteLink | null {
  if (input.length > 4096) return null;
  // Windows can supply an explicit root path before the query.
  const form = /^buzz:\/\/(join|connect|add-community)\/?\?/.exec(input)?.[1];
  if (!form) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "buzz:" ||
      url.host !== form ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const relay = url.searchParams.getAll("relay");
    if (relay.length !== 1 || !relay[0]) return null;
    // Unlike the reference's broad URL parser, the target transport is HTTPS-only.
    // Delegate origin validation to the same gate used by the manual join dialog.
    const community = communityDestination(relay[0]).url;
    if (form !== "join") return { community, code: "" };
    const codes = url.searchParams.getAll("code");
    const receipts = url.searchParams.getAll("policy_receipt");
    if (
      codes.length !== 1 ||
      receipts.length > 1 ||
      !codes[0] ||
      codes[0].length > 256 ||
      (receipts.length === 1 && !receipts[0])
    )
      return null;
    return { community, code: codes[0] };
  } catch {
    return null;
  }
}

/** Typed or pasted community input: the app link, the relay's invite page, or
 * a community address, where a bare host is a secure relay. A typed address
 * never resolves an alias. */
export function parsePastedInvite(input: string): InviteLink | null {
  const value = input.trim();
  if (value.length > 4096) return null;
  const link = parseInviteLink(value);
  if (link) return link;
  try {
    const url = new URL(value);
    const path = /^\/invite\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (path) {
      const code = decodeURIComponent(path);
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        code.length <= 256
        ? { community: communityDestination(url.origin).url, code }
        : null;
    }
  } catch {
    // Not a URL; a bare host is read as wss:// below.
  }
  try {
    return { community: enteredRelayOrigin(value), code: "" };
  } catch {
    return null;
  }
}
