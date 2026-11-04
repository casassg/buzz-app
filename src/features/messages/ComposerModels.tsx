import { useProfileGeneration } from "../relay/react";
import { Popover } from "@base-ui/react/popover";
import { EffortSlider } from "./composer-models/EffortSlider";
import { avatarMedia } from "../../shared/avatar-source";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { selectProfiles } from "../relay/profile-selection";
import type { ProfileQueries } from "../relay/profile-directory";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import {
  AgentsContext,
  useSessionState,
  useMentionModels,
  useAgentsSnapshot,
} from "../agents/react";
import type { MentionModelChoice } from "../agents/react";
import type { SessionPlace, SessionControlAction } from "../agents/service";
import type { MentionPicks, RunPick } from "../relay/messages";
import {
  CaretDownIcon,
  FoldIcon,
  CheckIcon,
  ArrowCounterClockwiseIcon,
  StopIcon,
  CircleNotchIcon,
  CircleDottedIcon,
  GaugeIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import styles from "./ComposerModels.module.css";

/** The draft's picks, each with the agent type it was made under. */
export type DraftPicks = Readonly<
  Record<string, RunPick & Readonly<{ type?: string }>>
>;

/** Model and effort for the next run of each mentioned agent of the viewer's
 * that offers a choice. Session controls act immediately on this conversation. */
export function ComposerModels({
  pubkeys,
  profiles,
  media,
  value,
  disabled,
  resettable = false,
  explicitOnly = false,
  onChange,
  onResolved,
  onRetryInventory,
  startsThread,
  place,
}: {
  pubkeys: readonly string[];
  profiles: ProfileQueries;
  media: Parameters<typeof avatarMedia>[1];
  value: DraftPicks;
  disabled: boolean;
  /** Solo chat picks are defaults for the chat until explicitly reset. */
  resettable?: boolean;
  /** A new Solo chat keeps provider defaults unchanged unless picked. */
  explicitOnly?: boolean;
  onChange(value: DraftPicks, resetPubkeys?: readonly string[]): void;
  /** null waits for choices; undefined invalidates the picker's snapshot. */
  onResolved(value: MentionPicks | null | undefined, error?: string): void;
  onRetryInventory?(): void;
  /** The message starts a thread of its own, as a channel's top-level one
   * does, so a thread-scoped agent has no session to act on. */
  startsThread: boolean;
  place: SessionPlace;
}) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const mentioned = useMentionModels(pubkeys, retry);
  const choices = useMemo<readonly MentionModelChoice[]>(
    () =>
      startsThread
        ? mentioned.flatMap((choice) => {
            if (choice.session !== "thread") return [choice];
            const { session: _, ...rest } = choice;
            return rest.loading ||
              rest.failed ||
              rest.models.length > 1 ||
              rest.models.some((model) => model.efforts.length)
              ? [rest]
              : [];
          })
        : mentioned,
    [mentioned, startsThread],
  );
  const profileKey = pubkeys.join(":");
  const selection = useMemo(
    () => selectProfiles(profiles, profileKey.split(":")),
    [profiles, profileKey],
  );
  // A mentioned agent need not be a member yet, so its profile may not be loaded.
  const profileGeneration = useProfileGeneration(profiles);
  useEffect(() => {
    void profileGeneration;
    if (profileKey)
      void profiles.ensure(profileKey.split(":"), "background").catch(() => {});
  }, [profiles, profileKey, profileGeneration]);
  const portraits = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const agents = useContext(AgentsContext);
  const agentSnapshot = useAgentsSnapshot(agents);
  const unavailableType =
    resettable &&
    pubkeys.some((pubkey) => {
      const agent = agentSnapshot?.agents.find(
        (item) => item.pubkey === pubkey,
      );
      return (
        (value[pubkey]?.model || value[pubkey]?.effort) &&
        agent &&
        !agents?.types().some((type) => type.key === agent.type)
      );
    });
  const unresolvedInventory =
    unavailableType ||
    (resettable &&
      (agentSnapshot?.status === "loading" ||
        agentSnapshot?.status === "error") &&
      pubkeys.some(
        (pubkey) =>
          (value[pubkey]?.model || value[pubkey]?.effort) &&
          !agentSnapshot.agents.some((agent) => agent.pubkey === pubkey),
      ));
  const inventoryFailed =
    unavailableType ||
    (unresolvedInventory && agentSnapshot?.status === "error");
  // A pick keeps the type it was made under: a retype drops it, even while
  // the new type's choices load or once they fail to, as none showed it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mentioned` follows the agents' snapshot, so a retype reruns this.
  useLayoutEffect(() => {
    const kept = Object.fromEntries(
      Object.entries(value).filter(([pubkey, { type }]) => {
        const now = agents?.find(pubkey)?.type;
        return !type || !now || now === type;
      }),
    );
    if (Object.keys(kept).length !== Object.keys(value).length) onChange(kept);
  }, [agents, mentioned, value, onChange]);
  const thumb = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Publish the displayed defaults separately from the user's draft picks.
  // A settings refresh or model-only pick must still follow the new default.
  useLayoutEffect(() => {
    const waitingForSavedChoices =
      resettable &&
      (unresolvedInventory ||
        choices.some(
          (choice) =>
            (choice.loading || choice.failed) &&
            (value[choice.pubkey]?.model || value[choice.pubkey]?.effort),
        ));
    if (waitingForSavedChoices) {
      onResolved(
        null,
        inventoryFailed || choices.some((choice) => choice.failed)
          ? "Saved model and effort choices could not be loaded. Open model and effort controls to retry or reset them."
          : undefined,
      );
      return () => onResolved(undefined);
    }
    const resolved: Record<string, RunPick> = resettable
      ? {}
      : Object.fromEntries(
          Object.entries(value).map(([pubkey, { model, effort }]) => [
            pubkey,
            { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
          ]),
        );
    for (const choice of choices) {
      if (choice.loading || choice.failed) continue;
      const saved = value[choice.pubkey] ?? {};
      const selected = choice.models.find((item) => item.id === saved.model);
      const runs = runModel(choice, saved.model);
      if (!runs?.id) continue;
      const explicitEffort = runs.efforts.find(
        (item) =>
          item.id === saved.effort &&
          (!resettable || !saved.model || selected !== undefined),
      )?.id;
      const effort =
        explicitEffort ??
        (runs.efforts.some((item) => item.id === runs.effort)
          ? runs.effort
          : undefined);
      if (choice.sendDefaults && !explicitOnly) {
        resolved[choice.pubkey] = {
          model: runs.id,
          ...(effort ? { effort } : {}),
        };
      } else if (resettable && (selected || explicitEffort)) {
        resolved[choice.pubkey] = {
          ...(selected ? { model: selected.id } : {}),
          ...(explicitEffort ? { effort: explicitEffort } : {}),
        };
      }
    }
    onResolved(resolved);
    return () => onResolved(undefined);
  }, [
    choices,
    value,
    onResolved,
    resettable,
    explicitOnly,
    unresolvedInventory,
    inventoryFailed,
  ]);
  const canReset =
    resettable &&
    pubkeys.some((pubkey) => value[pubkey]?.model || value[pubkey]?.effort);
  if (!choices.length && !inventoryFailed && !canReset) return null;
  const picked = choices.flatMap((choice) => {
    if (choice.loading) return [];
    const { model, effort } = value[choice.pubkey] ?? {};
    const runs = runModel(choice, model);
    const selected = choice.models.some((item) => item.id === model);
    const savedEffortApplies = !resettable || !model || selected;
    const supportedEffort = savedEffortApplies
      ? runs.efforts.find((item) => item.id === effort)
      : undefined;
    const text = [
      selected && runs.label,
      effort !== undefined && supportedEffort?.label,
    ]
      .filter(Boolean)
      .join(" · ");
    return text ? [choices.length > 1 ? `${choice.name}: ${text}` : text] : [];
  });
  const pick = (pubkey: string, next: RunPick) => {
    const { [pubkey]: _, ...rest } = value;
    const type = agents?.find(pubkey)?.type;
    onChange(
      next.model || next.effort
        ? { ...rest, [pubkey]: { ...next, ...(type ? { type } : {}) } }
        : rest,
    );
  };
  const label = choices.some((choice) => choice.session)
    ? `Model, effort, and session controls${resettable ? " for this chat" : ""}`
    : resettable
      ? "Model and effort for this chat"
      : "Model and effort for the next run";
  const target = resettable ? "this chat" : "next run";
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <Popover.Trigger
        disabled={disabled}
        render={
          <IconButton
            ref={trigger}
            size="toolbar"
            type="button"
            disabled={disabled}
            data-selected={picked.length ? "" : undefined}
            aria-label={label}
            title={
              picked.length
                ? `${label}. ${target}: ${picked.join(", ")}`
                : label
            }
            icon={<GaugeIcon size={18} aria-hidden="true" />}
          />
        }
      />
      <Popover.Portal>
        {/* The controls are the whole popup: it has no surface of its own. */}
        <Popover.Positioner
          className="buzz-popover-positioner"
          side="top"
          align="end"
          sideOffset={8}
          anchor={() => trigger.current?.closest("form") ?? trigger.current}
          collisionPadding={8}
        >
          <Popover.Popup
            className={styles.popup}
            aria-label={label}
            initialFocus={thumb}
          >
            {inventoryFailed && (
              <div className={`${styles.agent} floating-surface`}>
                <PanelHeader
                  variant="card"
                  title={<PanelHeaderLabel title="Model and effort" />}
                />
                <div className={styles.controls}>
                  <div className={styles.status}>
                    <span className={styles.statusCopy} role="alert">
                      Agents could not be loaded.
                    </span>
                    {onRetryInventory && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onRetryInventory();
                          setOpen(false);
                        }}
                      >
                        Retry agents
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {canReset && (
              <Button
                variant="subtle"
                size="sm"
                onClick={() => {
                  const addressed = new Set(pubkeys);
                  onChange(
                    Object.fromEntries(
                      Object.entries(value).filter(
                        ([pubkey]) => !addressed.has(pubkey),
                      ),
                    ),
                    [...addressed],
                  );
                  setOpen(false);
                }}
              >
                Reset model and effort
              </Button>
            )}
            {choices.map((choice, index) => (
              <AgentChoice
                key={choice.pubkey}
                choice={choice}
                avatarSrc={avatarMedia(
                  portraits.get(choice.pubkey)?.picture,
                  media,
                )}
                place={place}
                value={value[choice.pubkey] ?? {}}
                disabled={disabled}
                chatScoped={resettable}
                retry={() => setRetry((attempt) => attempt + 1)}
                pick={(next) => pick(choice.pubkey, next)}
                {...(index === 0 ? { thumb } : {})}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The model a run uses: the picked one, or else the agent's own. */
const runModel = (choice: MentionModelChoice, picked: string | undefined) =>
  choice.models.find((item) => item.id === picked) ??
  choice.models.find((item) => item.id === choice.current) ??
  choice.models[0] ?? { id: "", label: "", efforts: [] };

function AgentChoice({
  choice,
  avatarSrc,
  place,
  value,
  disabled,
  chatScoped,
  retry,
  pick,
  thumb,
}: {
  choice: MentionModelChoice;
  avatarSrc: string | undefined;
  place: SessionPlace;
  value: RunPick;
  disabled: boolean;
  chatScoped: boolean;
  retry(): void;
  pick(next: RunPick): void;
  thumb?: Ref<HTMLInputElement>;
}) {
  const [feedback, setFeedback] = useState("");
  if (choice.loading)
    return (
      <div
        className={`${styles.loading} floating-surface`}
        role="status"
        aria-busy="true"
      >
        <PanelHeader
          variant="card"
          title={<PanelHeaderLabel title={choice.name} />}
        />
        <div className={styles.controls}>
          <div className={styles.status}>
            <span className={styles.statusIcon}>
              <CircleNotchIcon
                size={20}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            </span>
            <div className={styles.statusCopy}>
              <ShimmerText>Loading model and effort…</ShimmerText>
            </div>
          </div>
        </div>
      </div>
    );
  const runs = runModel(choice, value.model);
  const selectedModel = choice.models.some((item) => item.id === value.model)
    ? value.model
    : undefined;
  const selectedEffort =
    !chatScoped || !value.model || selectedModel !== undefined
      ? runs.efforts.find((item) => item.id === value.effort)?.id
      : undefined;
  const several = choice.models.length > 1;
  // Chat choices stay explicit even when they match the provider default.
  // An effort the new model lacks falls back to its default.
  const chooseModel = (id: string) => {
    const next = choice.models.find((item) => item.id === id);
    const effort = next?.efforts.some((item) => item.id === value.effort)
      ? value.effort
      : undefined;
    pick({
      ...(chatScoped || id !== choice.current ? { model: id } : {}),
      ...(effort ? { effort } : {}),
    });
  };
  const model = (level?: string) =>
    several ? (
      <div className={styles.model}>
        <MenuRoot>
          <MenuTrigger
            disabled={disabled}
            aria-label={
              chatScoped
                ? `Model for ${choice.name} in this chat`
                : `Model for ${choice.name}'s next run`
            }
            render={
              <Button variant="subtle" size="sm">
                <span className={styles.about}>{runs.label}</span>
                {level && <span className={styles.level}>{level}</span>}
                <CaretDownIcon size={12} aria-hidden="true" />
              </Button>
            }
          />
          <MenuPopup size="compact" side="top" align="end">
            <MenuRadioGroup value={runs.id} onValueChange={chooseModel}>
              {choice.models.map((item) => (
                <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                  {item.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuRoot>
      </div>
    ) : (
      <span className={styles.fixedModel}>
        {runs.label}
        {level && <span className={styles.level}>{level}</span>}
      </span>
    );
  return (
    <div
      className={`${styles.agent} floating-surface`}
      data-agent-model-card=""
    >
      <PanelHeader
        variant="card"
        title={<PanelHeaderLabel title={choice.name} />}
        actions={
          choice.session && (
            <SessionActions
              key={`${choice.pubkey}:${place.channelId}:${place.root ?? ""}`}
              pubkey={choice.pubkey}
              name={choice.name}
              place={place}
              onFeedback={setFeedback}
            />
          )
        }
      />
      <div className={styles.controls}>
        {choice.failed ? (
          <div className={styles.status}>
            <span className={styles.statusCopy} role="alert">
              Model and effort could not be loaded.
            </span>
            <Button size="sm" disabled={disabled} onClick={retry}>
              Retry
            </Button>
          </div>
        ) : runs.efforts.length > 0 ? (
          <EffortSlider
            name={choice.name}
            chatScoped={chatScoped}
            avatarSrc={avatarSrc}
            model={model}
            efforts={runs.efforts}
            resting={runs.effort}
            value={selectedEffort}
            disabled={disabled}
            pick={(effort) =>
              pick({
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(effort ? { effort } : {}),
              })
            }
            {...(thumb ? { thumb } : {})}
          />
        ) : (
          <div className={styles.status}>
            <span className={styles.statusIcon}>
              <CircleDottedIcon size={20} aria-hidden="true" />
            </span>
            <div className={styles.statusCopy}>
              {runs.id && several ? (
                model()
              ) : (
                <span>
                  {runs.id
                    ? `${runs.label} · No thinking options`
                    : "Model unavailable"}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {feedback && (
        <span className={`${styles.about} ${styles.controls}`} role="status">
          {feedback}
        </span>
      )}
    </div>
  );
}

function SessionActions({
  pubkey,
  name,
  place,
  onFeedback,
}: {
  pubkey: string;
  name: string;
  place: SessionPlace;
  onFeedback(message: string): void;
}) {
  const agents = useContext(AgentsContext);
  const state = useSessionState(agents, [pubkey], place);
  const [started, setStarted] = useState<object>();
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(undefined), 3000);
    return () => clearTimeout(timer);
  }, [started]);
  const act = async (action: SessionControlAction) => {
    // Clearing first empties the live region, so a repeated success is
    // announced again.
    onFeedback("");
    setStarted(undefined);
    try {
      // Its membership in the selected community; a pubkey alone is refused.
      await agents?.session(agents.find(pubkey)?.key ?? pubkey, place, action);
      if (action === "new") {
        setHintDismissed(false);
        setStarted({});
      } else {
        onFeedback(
          action === "compact" ? "Session compacted" : "Interrupt requested",
        );
      }
    } catch (error) {
      onFeedback(
        error instanceof Error ? error.message : "Session action failed",
      );
    }
  };
  return (
    <fieldset className={styles.actions} aria-label={`${name}'s session`}>
      <span className="sr-only" role="status">
        {started ? "New session started" : ""}
      </span>
      {(
        [
          ["compact", "Compact session", FoldIcon],
          ["new", "Start a new session", ArrowCounterClockwiseIcon],
          ["interrupt", "Interrupt", StopIcon],
        ] as const
      ).map(([action, label, Icon]) => {
        const enabled =
          action === "interrupt"
            ? state === "active" || state === "compacting"
            : state === "idle";
        const title =
          state === "unavailable"
            ? `${label}: session controls unavailable. Check the agent's connection and the app running it.`
            : state === "compacting"
              ? action === "interrupt"
                ? "Interrupt compaction"
                : "Compacting session. Wait for it to finish, or interrupt it."
              : enabled
                ? label
                : action === "interrupt"
                  ? "Nothing to interrupt. The session is idle."
                  : `Wait for the active turn to finish before ${action === "compact" ? "compacting" : "starting a new session"}.`;
        const succeeded = action === "new" && !!started;
        return (
          <Tooltip
            key={action}
            content={succeeded ? "New session started" : title}
            {...(succeeded && !hintDismissed ? { open: true } : {})}
            onOpenChange={(open) => {
              if (!open && succeeded) setHintDismissed(true);
            }}
          >
            <IconButton
              size="sm"
              type="button"
              icon={
                succeeded ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <Icon aria-hidden="true" />
                )
              }
              aria-label={label}
              disabled={!enabled}
              loading={action === "compact" && state === "compacting"}
              focusableWhenDisabled
              onClick={() => void act(action)}
            />
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
