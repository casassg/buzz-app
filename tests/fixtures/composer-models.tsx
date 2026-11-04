// The real composer control and React lifecycle, with a read-only model catalog.
// No native harness, relay, credentials or live agent execution.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerModels } from "../../src/features/messages/ComposerModels";
import { AgentsContext } from "../../src/features/agents/react";
import type { Agents } from "../../src/features/agents/service";
import type { DraftPicks } from "../../src/features/messages/ComposerModels";
import {
  parseSoloModelPicks,
  soloModelPicksKey,
  updateSoloModelPicks,
} from "../../src/features/messages/solo-model-picks";
import { subscribeView, viewRevision } from "../../src/shared/view-state";
import type { ProfileQueries } from "../../src/features/relay/profile-directory";
import { createAppearance } from "../../src/shared/theme/service";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

createAppearance();
const pubkey = "a".repeat(64);
const peer = "b".repeat(64);
const persistence = new URLSearchParams(window.location.search).has("persist");
const scope = "composer-models-fixture";
const key = soloModelPicksKey("fixture");
const snapshot = {
  status: "ready",
  agents: [
    { pubkey, name: "Honey", type: "test/agent" },
    { pubkey: peer, name: "Bumble", type: "test/agent" },
  ],
};
let failCatalog = new URLSearchParams(window.location.search).has(
  "catalog-error",
);
const types = [
  {
    key: "test/agent",
    models: () => {
      if (failCatalog) {
        failCatalog = false;
        throw new Error("Fixture catalog is temporarily unavailable");
      }
      return {
        current: "fixture",
        models: [
          {
            id: "fixture",
            label: "Fixture model",
            effort: "medium",
            efforts: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
          {
            id: "alternate",
            label: "Alternate model",
            effort: "medium",
            efforts: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
        ],
      };
    },
  },
];
// The catalog is immutable; these are the only service reads the control uses.
const agents = {
  find: (key: string) => snapshot.agents.find((agent) => agent.pubkey === key),
  subscribe: () => () => {},
  snapshot: () => snapshot,
  types: () => types,
} as unknown as Agents;
// No profile picture: the handle shows initials and the fill stays the theme accent.
const profiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};
const media = () => undefined;
const ignoreResolved = () => {};
function Fixture() {
  useKeyboardFocusVisibility();
  const solo = new URLSearchParams(window.location.search).has("solo");
  const [picks, setPicks] = useState<DraftPicks>(() =>
    persistence ? parseSoloModelPicks(viewRevision(scope, key)) : {},
  );
  const [error, setError] = useState("");
  useEffect(
    () =>
      persistence
        ? subscribeView(scope, () =>
            setPicks(parseSoloModelPicks(viewRevision(scope, key))),
          )
        : undefined,
    [],
  );
  const changePicks = (next: DraftPicks, reset: readonly string[] = []) => {
    setPicks(next);
    if (!persistence) return;
    const changed = new Set([
      ...Object.keys(picks),
      ...Object.keys(next),
      ...reset,
    ]);
    const edits = new Map(
      [...changed]
        .filter(
          (pubkey) =>
            reset.includes(pubkey) ||
            JSON.stringify(picks[pubkey]) !== JSON.stringify(next[pubkey]),
        )
        .map((pubkey) => [pubkey, next[pubkey]]),
    );
    void updateSoloModelPicks(scope, key, edits).catch((reason) =>
      setError(String(reason)),
    );
  };
  return (
    <AgentsContext.Provider value={agents}>
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h1 className="text-title">Composer model and effort</h1>
        <button type="button">Outside the picker</button>
        {error && <p role="alert">{error}</p>}
        <form aria-label="Composer controls">
          <ComposerModels
            pubkeys={persistence ? [pubkey, peer] : [pubkey]}
            profiles={profiles}
            media={media}
            value={picks}
            disabled={false}
            resettable={solo}
            explicitOnly={solo}
            startsThread={false}
            place={{ channelId: "fixture" }}
            onChange={changePicks}
            onResolved={ignoreResolved}
          />
        </form>
      </main>
    </AgentsContext.Provider>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(<Fixture />);
