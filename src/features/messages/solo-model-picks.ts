import type { DraftPicks } from "./ComposerModels";
import { viewRevision, writeView } from "../../shared/view-state";

export const soloModelPicksKey = (channelId: string) =>
  `solo:model-picks:${channelId}`;

export function parseSoloModelPicks(
  revision: string | null | undefined,
): DraftPicks {
  let saved: unknown;
  try {
    saved = JSON.parse(revision ?? "null");
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).flatMap(([pubkey, pick]) => {
      if (
        !/^[0-9a-f]{64}$/.test(pubkey) ||
        !pick ||
        typeof pick !== "object" ||
        Array.isArray(pick)
      )
        return [];
      const record = pick as Record<string, unknown>;
      const model = typeof record.model === "string" ? record.model : undefined;
      const effort =
        typeof record.effort === "string" ? record.effort : undefined;
      const type = typeof record.type === "string" ? record.type : undefined;
      return model || effort
        ? [
            [
              pubkey,
              {
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(type ? { type } : {}),
              },
            ],
          ]
        : [];
    }),
  );
}

/** One scope lock also covers New chat transfers; never hold it over delivery. */
export async function lockSoloModelPicks<T>(scope: string, run: () => T) {
  if (!navigator.locks) throw new Error("Window ownership is unavailable.");
  return navigator.locks.request(`buzz-solo-model-picks:${scope}`, run);
}

export function updateSoloModelPicks(
  scope: string,
  key: string,
  edits: ReadonlyMap<string, DraftPicks[string] | undefined>,
) {
  return lockSoloModelPicks(scope, () => {
    const revision = viewRevision(scope, key);
    if (revision === undefined)
      throw new Error("Saved choices are unreadable.");
    const picks = { ...parseSoloModelPicks(revision) };
    for (const [pubkey, pick] of edits) {
      if (pick) picks[pubkey] = pick;
      else delete picks[pubkey];
    }
    if (!writeView(scope, key, picks))
      throw new Error("Choices were not saved.");
    return { picks, revision: JSON.stringify(picks) };
  });
}
