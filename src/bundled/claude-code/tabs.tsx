import { ModelDiscoveryRecovery } from "../../features/agents/ModelDiscoveryRecovery";
import activityStyles from "../../features/agents/ActivityLayout.module.css";
import { formatItemTimestamp } from "../../shared/datetime";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ProviderDialogActions } from "../../features/agents/ProviderDialogActions";
// Claude's provider controls, New agent choices, and agent settings.
import {
  useEffect,
  useRef,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { CreateModelChoices } from "../../features/agents/CreateModelChoices";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  ConversationName,
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { CircleNotchIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type ClaudeRuntime,
  type Config,
  config as readConfig,
  effortChoices,
  effortLabel,
  effortLevels,
  type SavedConversation,
  modelName as resolvedModelName,
} from "./runtime";
import type { ClaudeModel } from "./claude";
import type { ClaudeSetup } from "./setup";
import type { ClaudeDefaults } from "./defaults";
import { type ClaudeTranscript, TURN_LIMIT } from "./transcript";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
const CONVERSATION_LIMIT = 30;
type Read =
  | { status: "ready"; transcript: ClaudeTranscript }
  | { status: "missing" }
  | { status: "error"; error: string };

const options = (choices: readonly (readonly [string, string])[]) => [
  { label: "", options: choices.map(([value, label]) => ({ value, label })) },
];
const modelOptionCopy = (model: ClaudeModel) => {
  const label = model.resolvedModel
    ? resolvedModelName(model.resolvedModel)
    : (model.displayName ?? model.value);
  const descriptionPrefix = `${label} · `;
  const description = model.description?.startsWith(descriptionPrefix)
    ? model.description.slice(descriptionPrefix.length)
    : model.description;

  return { label, description };
};
/** The models Claude lists; `default` is the picker's own default row. */
const modelChoices = (models: readonly ClaudeModel[]) =>
  models
    .filter((model) => model.value !== "default")
    .map((model) => ({ id: model.value, ...modelOptionCopy(model) }));
const modelName = (model: string, models: readonly ClaudeModel[]) =>
  modelChoices(models).find((choice) => choice.id === model)?.label ??
  resolvedModelName(model);
const providerDefaultModel = (
  model: string,
  models: readonly ClaudeModel[],
) => {
  if (model)
    return (
      models.find(
        (candidate) =>
          candidate.value !== "default" &&
          (candidate.value === model || candidate.resolvedModel === model),
      )?.value ?? model
    );
  const resolved = models.find(
    (candidate) => candidate.value === "default",
  )?.resolvedModel;
  return resolved
    ? models.find(
        (candidate) =>
          candidate.value !== "default" &&
          (candidate.resolvedModel === resolved ||
            candidate.value === resolved),
      )?.value
    : undefined;
};
const providerDefaultLabel = (
  model: string,
  models: readonly ClaudeModel[],
) => {
  if (model) return modelName(model, models);
  const native = models.find((candidate) => candidate.value === "default");
  return native?.resolvedModel
    ? resolvedModelName(native.resolvedModel)
    : "Model unavailable";
};
/** The effort levels of the model a run uses, `""` being Claude's default;
 * a model Claude does not list may run at any level a listed one has. */
const effortsFor = (model: string, models: readonly ClaudeModel[]) => {
  const id = model || "default";
  const listed = models.find(
    (candidate) => candidate.value === id || candidate.resolvedModel === id,
  );
  return effortChoices(
    listed ? effortLevels(listed) : models.flatMap(effortLevels),
  );
};
const thinkingOptions = (
  model: string,
  models: readonly ClaudeModel[],
  effort: string,
) => {
  const efforts = effortsFor(model, models);
  return [
    { value: "", label: "Automatic · Default" },
    ...(effort && !efforts.some((level) => level.id === effort)
      ? [
          {
            value: effort,
            label: models.length
              ? `${effortLabel(effort)} (unavailable)`
              : effortLabel(effort),
          },
        ]
      : []),
    ...efforts.map(({ id, label }) => ({ value: id, label })),
  ];
};
const SCOPES = options([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);

function ClaudeSignIn({
  setup,
  disabled,
}: {
  setup: ClaudeSetup;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const missing = state.status?.state === "missing";
  const outdated = state.status?.state === "outdated";
  return (
    <>
      <Button
        size="sm"
        variant="prominent"
        disabled={disabled || !!state.running}
        onClick={() => {
          if (setup.snapshot().running) return;
          setOpen(true);
          void setup.run(missing || outdated ? "install" : "login");
        }}
      >
        {missing ? "Install Claude" : outdated ? "Update Claude" : "Sign in"}
      </Button>
      <Dialog
        open={open}
        title={missing || outdated ? "Set up Claude" : "Sign in to Claude"}
        description="Continue in your browser. If it gives you a code to paste, choose Enter a code below."
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void setup.cancel();
        }}
      >
        <ClaudeSetupPanel setup={setup} disabled={disabled} variant="compact" />
      </Dialog>
    </>
  );
}

function ClaudeSetupPanel({
  setup,
  disabled = false,
  variant = "full",
}: {
  setup: ClaudeSetup;
  disabled?: boolean;
  variant?: "full" | "compact";
}) {
  const state = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (!setup.snapshot().status) void setup.check();
  }, [setup]);
  const status = state.status;
  const line =
    !status || state.checking
      ? "Checking Claude…"
      : status.state === "missing"
        ? "Claude is not installed."
        : status.state === "outdated"
          ? `Claude ${status.version} is older than Buzz needs.`
          : status.state === "signed-out"
            ? `Claude ${status.version} needs you to sign in.`
            : status.state === "ready"
              ? `Claude ${status.version} is ready${status.account ? ` (${status.account})` : ""}.`
              : status.message;
  // One button per slot, so focus stays put as Install becomes Sign in and
  // Cancel becomes Check again.
  const action =
    status?.state === "missing"
      ? ({ step: "install", label: "Install Claude" } as const)
      : status?.state === "outdated"
        ? ({ step: "install", label: "Update Claude" } as const)
        : status?.state === "signed-out"
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
  return (
    <section className="grid gap-2">
      {!(variant === "compact" && status?.state === "signed-out") && (
        <p role="status" className="m-0">
          {line}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {action && (
          <Button
            variant="prominent"
            size={variant === "compact" ? "sm" : "md"}
            loading={state.running === action.step}
            disabled={
              disabled || (!!state.running && state.running !== action.step)
            }
            onClick={() => void setup.run(action.step)}
          >
            {action.label}
          </Button>
        )}
        {(variant !== "compact" ||
          status?.state !== "signed-out" ||
          state.running) && (
          <Button
            variant="ghost"
            disabled={!state.running && state.checking}
            focusableWhenDisabled
            onClick={() =>
              void (state.running ? setup.cancel() : setup.check(true))
            }
          >
            {state.running ? "Cancel" : "Check again"}
          </Button>
        )}
      </div>
      {status?.state === "missing" && (
        <p className="m-0 text-body-sm text-subtle">
          Downloads Buzz's own copy of Claude (about 250 MB) from
          downloads.claude.ai and keeps it on the latest release. It does not
          change the <code>claude</code> in your terminal, and uses the same
          sign-in and settings.
        </p>
      )}
      {state.output && (
        <Accordion
          items={[
            {
              value: "details",
              title: "Setup details",
              content: (
                <pre
                  role="log"
                  aria-label="Setup output"
                  className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all text-caption"
                >
                  {state.output}
                </pre>
              ),
            },
          ]}
        />
      )}
      {state.running === "login" && (
        <Accordion
          items={[
            {
              value: "code",
              title: "Enter a code",
              content: (
                <div className="flex items-end gap-2">
                  <Field
                    label="Sign-in code"
                    description="If the browser shows a code to paste, enter it here."
                  >
                    <Input
                      autoFocus
                      disabled={disabled}
                      value={code}
                      onValueChange={setCode}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !code.trim() || disabled)
                          return;
                        event.preventDefault();
                        void setup.answer(code);
                        setCode("");
                      }}
                    />
                  </Field>
                  <Button
                    disabled={disabled || !code.trim()}
                    onClick={() => {
                      void setup.answer(code);
                      setCode("");
                    }}
                  >
                    Send
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}

export function createTabs({
  setup,
  defaults,
  runtime,
}: Readonly<{
  setup: ClaudeSetup;
  defaults: ClaudeDefaults;
  runtime: ClaudeRuntime;
}>) {
  function useSetupCatalog() {
    const state = useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
      setup.snapshot,
    );
    useEffect(() => {
      if (!state.status && !state.checking) void setup.check();
    }, [state.status, state.checking]);
    // Once per change of readiness: a failed load waits for Try again.
    useEffect(() => {
      if (
        !state.checking &&
        state.status?.state === "ready" &&
        state.models.length === 0
      )
        void setup.loadModels();
    }, [state.status, state.checking, state.models.length]);
    return state;
  }

  function CreateModel({
    config,
    onChange,
    ...props
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const state = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
    );
    if (!state.status)
      return (
        <span role="status" className="text-body-sm text-secondary">
          Checking sign-in…
        </span>
      );
    if (state.status.state !== "ready" || state.running)
      return <ClaudeSignIn setup={setup} disabled={props.disabled} />;
    return (
      <CreateModelChoices
        {...props}
        models={modelChoices(state.models)}
        value={current.model}
        defaultModel={providerDefaultModel(
          providerDefaults.model,
          state.models,
        )}
        defaultLabel={providerDefaultLabel(
          providerDefaults.model,
          state.models,
        )}
        defaultDescription="Following the provider's model default"
        loading={state.modelsChecking}
        error={state.modelsError}
        retry={() => void setup.loadModels(true)}
        onChange={(model) => {
          const next = effortsFor(
            model || providerDefaults.model,
            state.models,
          );
          onChange({
            ...current,
            model,
            effort:
              state.models.length === 0 ||
              next.some((level) => level.id === current.effort)
                ? current.effort
                : "",
          });
        }}
      />
    );
  }

  function CreateThinking({
    config,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { effort, model } = current;
    const state = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
    );
    useEffect(() => {
      if (
        disabled ||
        state.checking ||
        state.status?.state !== "ready" ||
        state.running ||
        state.modelsChecking ||
        state.modelsError ||
        !state.models.length ||
        !effort
      )
        return;
      const efforts = effortsFor(model || providerDefaults.model, state.models);
      if (!efforts.some((level) => level.id === effort))
        onChange(readConfig({ ...config, effort: "" }));
    }, [
      config,
      disabled,
      effort,
      model,
      onChange,
      providerDefaults.model,
      state.checking,
      state.models,
      state.modelsChecking,
      state.modelsError,
      state.running,
      state.status?.state,
    ]);
    const effortOptions = thinkingOptions(
      current.model || providerDefaults.model,
      state.models,
      current.effort,
    );
    return (
      <Select
        label="Thinking"
        valueLabel={current.effort ? undefined : "Automatic"}
        valueSuffix={current.effort ? undefined : " · Default"}
        variant="compact"
        value={current.effort}
        groups={[{ label: "", options: effortOptions }]}
        disabled={
          disabled ||
          state.status?.state !== "ready" ||
          Boolean(state.running) ||
          state.modelsChecking ||
          Boolean(state.modelsError) ||
          state.models.length === 0
        }
        onValueChange={(effort) => onChange({ ...current, effort })}
      />
    );
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    return (
      <AgentInstructions
        creation
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** Claude Code installation and account readiness on this computer. */
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    const state = useSetupCatalog();
    const saved = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const [error, setError] = useState("");
    return (
      <>
        <ModelDiscoveryRecovery
          error={state.modelsError}
          loading={state.modelsChecking}
          retry={() => void setup.loadModels(true)}
        >
          <ModelPicker
            includeDefault={false}
            resetLabel="Use Claude default"
            compact
            groupByFamily
            label="Claude default model"
            models={modelChoices(state.models).map((choice) => ({
              ...choice,
              efforts: (() => {
                const model = state.models.find(
                  (item) => item.value === choice.id,
                );
                const levels = model ? effortChoices(effortLevels(model)) : [];
                return levels.length
                  ? [{ id: "", label: "Automatic" }, ...levels]
                  : [];
              })(),
            }))}
            effort={saved.effort ?? ""}
            effortLabel={saved.effort ? effortLabel(saved.effort) : "Automatic"}
            onEffortChange={(model, effort) => {
              defaults.save({ model, effort }).then(
                () => setError(""),
                (reason) => setError(String(reason)),
              );
            }}
            value={
              saved.model
                ? (providerDefaultModel(saved.model, state.models) ??
                  saved.model)
                : ""
            }
            defaultModel={providerDefaultModel("", state.models)}
            defaultLabel={providerDefaultLabel("", state.models)}
            onConfigure={onConfigure}
            onChange={(model) => {
              defaults.save({ model }).then(
                () => setError(""),
                (reason) => setError(String(reason)),
              );
            }}
          />
        </ModelDiscoveryRecovery>
        {error && <span role="alert">{error}</span>}
      </>
    );
  }

  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const state = useSetupCatalog();
    const [code, setCode] = useState("");
    const status = state.status;
    const ready = status?.state === "ready" && !state.checking;
    const line =
      !status || state.checking
        ? "Checking Claude…"
        : status.state === "missing"
          ? "Claude is not installed."
          : status.state === "outdated"
            ? `Claude ${status.version} is older than Buzz needs.`
            : status.state === "signed-out"
              ? `Claude ${status.version} needs you to sign in.`
              : status.state === "error"
                ? status.message
                : undefined;
    const action =
      status?.state === "missing"
        ? ({ step: "install", label: "Install Claude" } as const)
        : status?.state === "outdated"
          ? ({ step: "install", label: "Update Claude" } as const)
          : status?.state === "signed-out"
            ? ({ step: "login", label: "Sign in" } as const)
            : undefined;
    const latestOutputLine = state.output
      .replaceAll("\r", "\n")
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .at(-1);
    return (
      <div className="grid gap-6">
        {state.notice && (
          <p role="status" className="m-0 text-body-sm">
            {state.notice}
          </p>
        )}
        <div className="grid gap-2" hidden={ready}>
          {!state.running && (
            <p
              role={status?.state === "error" ? "alert" : "status"}
              className="m-0 text-body-sm text-primary"
            >
              <strong>{line}</strong>
            </p>
          )}
          {state.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <p
                role="status"
                className="m-0 flex items-center gap-2 text-body-sm"
              >
                <CircleNotchIcon
                  size={16}
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
                {state.running === "login"
                  ? "Waiting for Claude Code sign-in…"
                  : (latestOutputLine ?? "Installing Claude Code…")}
              </p>
            </div>
          ) : null}
          {status?.state === "missing" && !state.running && (
            <p className="m-0 text-body-sm text-subtle">
              Downloads Buzz's own copy of Claude (about 250 MB) from
              downloads.claude.ai and keeps it on the latest release. It does
              not change the <code>claude</code> in your terminal, and uses the
              same sign-in and settings.
            </p>
          )}
          {state.output && state.running !== "install" && (
            <div
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-body-sm text-subtle"
            >
              {state.output}
            </div>
          )}
          {state.running === "login" && (
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void setup.answer(code);
                setCode("");
              }}
            >
              <Field
                label="Sign-in code"
                description="If the browser shows a code to paste, enter it here."
              >
                <div className="flex items-center gap-2">
                  <Input value={code} onValueChange={setCode} />
                  <Button type="submit" disabled={!code.trim()}>
                    Send
                  </Button>
                </div>
              </Field>
            </form>
          )}
          {status?.state === "error" && (
            <p className="m-0 text-body-sm text-subtle">
              Open Claude Code in a terminal for more details, then please try
              again.
            </p>
          )}
        </div>
        {ready && (
          <p className="m-0 text-body-sm text-subtle">Claude is signed in.</p>
        )}
        <ProviderDialogActions>
          <Button
            onClick={() =>
              state.running && !ready ? void setup.cancel() : onClose()
            }
          >
            {ready ? "Done" : "Cancel"}
          </Button>
          {!ready && action && !state.running && !state.checking && (
            <Button
              autoFocus
              variant="prominent"
              onClick={() => void setup.run(action.step)}
            >
              {action.label}
            </Button>
          )}
        </ProviderDialogActions>
      </div>
    );
  }

  /** One conversation's session file, read on open and on Refresh. A refresh
   * keeps the last result in place until the new one arrives. */
  function TranscriptView({
    agent,
    conversation,
    working,
    openConversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
    working: boolean;
    openConversation: AgentViewProps<Config>["openConversation"];
  }) {
    const workspace = readConfig(agent.config).workspace;
    const [read, setRead] = useState<Read>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // A turn ending rereads, so its last steps show without a Refresh.
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void runtime
        .transcript(conversation, workspace, working, abort.signal)
        .then(
          (transcript): Read =>
            transcript
              ? { status: "ready", transcript }
              : { status: "missing" },
          (reason): Read => ({ status: "error", error: message(reason) }),
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [conversation, workspace, working, attempt]);
    return (
      <div className={activityStyles.transcript}>
        <InlineHeader
          title="Transcript"
          actions={
            <IconButton
              hint="familiar"
              aria-label="Refresh transcript"
              title="Refresh transcript"
              loading={loading}
              onClick={() => setAttempt((value) => value + 1)}
              icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
        {read && loading && (
          <span role="status" className="sr-only">
            Refreshing transcript…
          </span>
        )}
        {!read ? (
          <p role="status" className="m-0">
            Reading the Claude session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            Claude has no transcript for this conversation on this computer. It
            may have been deleted, or the session ran in a different workspace.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Claude session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            openConversation={openConversation}
            state={() => (working ? "working" : undefined)}
            before={
              <>
                {read.transcript.incomplete && (
                  <p role="status" className="m-0 text-body-sm">
                    Some of this conversation’s sessions may be missing. Refresh
                    to try again.{" "}
                    <span className="text-subtle">
                      ({read.transcript.incomplete.split("\n")[0]})
                    </span>
                  </p>
                )}
                {read.transcript.more && (
                  <p className="m-0 text-body-sm text-subtle">
                    Showing the latest {TURN_LIMIT} turns.
                  </p>
                )}
              </>
            }
          />
        )}
      </div>
    );
  }

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
    openConversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    initialTranscript?: AgentViewProps<Config>["initialTranscript"];
    close?: AgentViewProps<Config>["close"];
    openConversation?: AgentViewProps<Config>["openConversation"];
  }) {
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.key),
    );
    const conversations = runtime.conversations(agent.key);
    const busy = new Map(
      sessions.map((session) => [session.key, session.busy]),
    );
    const workspace = readConfig(agent.config).workspace;
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      conversations,
      conversation,
      (place, signal) => runtime.find(agent.key, place, workspace, signal),
      (channelId) => runtime.channelLabel(agent.key, channelId),
    );
    const recent = conversations
      .filter((item) => item.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    const activity = (key: string) => {
      const running = busy.get(key);
      return running === undefined ? undefined : running ? "Working" : "Idle";
    };
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Claude"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && activity(here.key)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent conversations" />
          <SettingsGroup layout="form">
            {recent.length ? (
              <ul className={activityStyles.list}>
                {recent.map((item) => (
                  <li key={item.key} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <ConversationName
                          session={item}
                          title={label(item)}
                          className="text-label-sm"
                        />
                        <span className="block text-body-sm text-subtle">
                          {[
                            item.root
                              ? `Thread ${item.root.slice(0, 8)}`
                              : "Channel",
                            activity(item.key),
                            formatItemTimestamp(item.at / 1000, {
                              withTime: true,
                            }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="subtle"
                        size="sm"
                        aria-label={`View transcript: ${label(item)}`}
                        onClick={() => show(item)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-body-sm text-subtle">
                No other conversations saved in this app yet.
              </p>
            )}
          </SettingsGroup>
        </section>
        {open && (
          <PanelSubview
            title={label(open)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              key={open.key}
              agent={agent}
              conversation={open}
              working={busy.get(open.key) ?? false}
              openConversation={openConversation}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** What the agent runs with. Saving restarts idle sessions with the change. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const setupState = useSetupCatalog();
    const providerDefaults = useSyncExternalStore(
      defaults.subscribe,
      defaults.snapshot,
      defaults.snapshot,
    );
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || "~/.buzz",
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const effortOptions = thinkingOptions(
      draft.model || providerDefaults.model,
      setupState.models,
      draft.effort,
    );
    const modelControl = (
      <>
        <ModelPicker
          allowCustomModel
          models={modelChoices(setupState.models)}
          value={draft.model}
          defaultModel={providerDefaultModel(
            providerDefaults.model,
            setupState.models,
          )}
          defaultLabel={providerDefaultLabel(
            providerDefaults.model,
            setupState.models,
          )}
          defaultDescription="Following the provider's model default"
          loading={setupState.modelsChecking}
          onChange={(model) => {
            // An effort the new model does not list goes back to the default;
            // without Claude's list, the effort is kept.
            const next = effortsFor(
              model || providerDefaults.model,
              setupState.models,
            );
            setDraft({
              ...draft,
              model,
              effort:
                setupState.models.length === 0 ||
                next.some((level) => level.id === draft.effort)
                  ? draft.effort
                  : "",
            });
          }}
        />
        <Select
          label="Thinking"
          valueLabel={draft.effort ? undefined : "Automatic"}
          valueSuffix={draft.effort ? undefined : " · Default"}
          variant="preference"
          value={draft.effort}
          groups={[{ label: "", options: effortOptions }]}
          onValueChange={(effort) => setDraft({ ...draft, effort })}
        />
      </>
    );
    return (
      <form
        id={form}
        className="grid gap-4 [container-type:inline-size]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <p
            ref={saveErrorRef}
            tabIndex={-1}
            role="alert"
            className="buzz-field-error"
          >
            {error}
          </p>
        )}
        {settingsSection !== "runtime" && (
          <>
            <SettingsGroup>
              {settingsHost?.typeControl?.(configChanged)}
              {modelControl}
            </SettingsGroup>
            <AgentInstructions
              value={draft.instructions}
              disabled={false}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <Field
              label="Workspace"
              description="The folder Claude works in. Use ~/ for your home folder."
            >
              <Input
                value={draft.workspace}
                onValueChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </Field>
            <Select
              label="Sessions"
              variant="preference"
              value={draft.scope}
              groups={SCOPES}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  scope: value === "channel" ? "channel" : "thread",
                })
              }
            />
          </>
        )}
        <AgentSaveButton form={form} saving={saving} disabled={!changed} />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return {
    CreateModel,
    CreateThinking,
    Create,
    ProviderDialogBody,
    DefaultControl,
    SettingsTab,
    ActivityTab,
  };
}
