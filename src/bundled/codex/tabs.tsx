import activityStyles from "../../features/agents/ActivityLayout.module.css";
import { formatItemTimestamp } from "../../shared/datetime";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { ProviderDialogActions } from "../../features/agents/ProviderDialogActions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
// The type's tabs: Codex's setup on this computer, and the agent's settings;
// and its part of the New agent dialog.
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
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  ConversationName,
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import type {
  AgentCreateProps,
  AgentProviderSnapshot,
  AgentViewProps,
} from "../../features/agents/service";
import { localStore, type AgentStore } from "../../features/agents/store";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  config as readConfig,
  defaults,
  resolveModel,
  effortName,
  validWorkspace,
  type Config,
  type Model,
} from "./config";
import { AppServer, listModels, needsSignIn, type Spawn } from "./rpc";
import type { CodexRuntime, SavedConversation } from "./runtime";
import type { CodexSetup } from "./setup";
import { readTranscript, TURN_LIMIT, type CodexTranscript } from "./transcript";

const label = ({ channelId, name, root }: SavedConversation) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
type Read =
  | { status: "ready"; transcript: CodexTranscript }
  | { status: "missing" }
  | { status: "error"; error: string };

type Catalog = {
  models: Model[];
};
type ProviderDefaults = Readonly<{ model: string; effort: string }>;
type ProviderState = AgentProviderSnapshot &
  Readonly<{
    checking: boolean;
    data: Catalog | undefined;
    error: string;
    defaults: ProviderDefaults;
  }>;
const STORAGE_KEY = "buzz.codex.provider-defaults.v1";
const SIGN_IN_ERROR = "Codex needs you to sign in.";
const NOT_INSTALLED = "Codex is not installed.";
const CONVERSATION_LIMIT = 30;
/** Read-only setup/catalog discovery uses the same declared native transport. */
async function catalog(spawn: Spawn, signal: AbortSignal) {
  const rpc = new AppServer();
  const abort = () => {
    void rpc.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.open(spawn, defaults.workspace);
    signal.throwIfAborted();
    if (await needsSignIn(rpc)) throw new Error(SIGN_IN_ERROR);
    return { models: await listModels(rpc) };
  } finally {
    signal.removeEventListener("abort", abort);
    await rpc.close();
  }
}

/** Codex's one device-wide health/catalog view and versioned default store. */
export class CodexProvider {
  private state: ProviderState;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private readonly offSetup: (() => void) | undefined;

  constructor(
    private readonly spawn: Spawn,
    private readonly storage: AgentStore = localStore(),
    private readonly setup?: CodexSetup,
  ) {
    this.state = Object.freeze({
      readiness: "checking",
      checking: false,
      data: undefined,
      error: "",
      defaults: this.readDefaults(),
    });
    // An install or sign-in holds the dialog open, then Codex is checked again.
    this.offSetup = setup?.subscribe(() => {
      const running = Boolean(setup.snapshot().running);
      if (running === Boolean(this.state.blocking)) return;
      const { blocking: _, ...rest } = this.state;
      this.state = Object.freeze(running ? { ...rest, blocking: true } : rest);
      for (const listener of this.listeners) listener();
      if (!running) void this.check();
    });
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(change: Partial<ProviderState>) {
    this.state = Object.freeze({ ...this.state, ...change });
    for (const listener of this.listeners) listener();
  }
  check() {
    if (this.pending) return this.pending;
    const pending = this.runCheck();
    this.pending = pending;
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }
  private async runCheck() {
    const abort = new AbortController();
    this.abort = abort;
    this.set({
      ...(this.state.data ? {} : { readiness: "checking" as const }),
      checking: true,
      error: "",
    });
    try {
      const status = await this.setup?.check();
      if (status && status.state !== "ready")
        throw new Error(
          status.state === "missing"
            ? NOT_INSTALLED
            : status.state === "signed-out"
              ? SIGN_IN_ERROR
              : status.message,
        );
      const data = await catalog(this.spawn, abort.signal);
      if (this.abort === abort) {
        this.set({
          readiness: "ready",
          checking: false,
          data,
          error: "",
        });
      }
    } catch (error) {
      const reason = message(error);
      if (this.abort === abort && !abort.signal.aborted)
        this.set({
          readiness: "attention",
          attentionLabel:
            reason === NOT_INSTALLED
              ? "Install Codex"
              : reason === SIGN_IN_ERROR
                ? "Log in to Codex"
                : "Codex needs attention",
          checking: false,
          data: undefined,
          error: reason,
        });
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }
  /** Settles once the defaults are saved, and only then uses them; rejects,
   * keeping the saved ones, when they could not be saved. */
  async saveDefaults(next: ProviderDefaults) {
    const selected = this.model(next.model);
    const effort =
      !next.effort ||
      selected?.supportedReasoningEfforts.some(
        (choice) => choice.reasoningEffort === next.effort,
      )
        ? next.effort
        : (selected?.defaultReasoningEffort ?? "");
    const defaults = Object.freeze({ model: next.model, effort });
    await this.storage.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, ...defaults }),
    );
    this.set({ defaults });
  }
  resolve(raw: unknown): Config {
    const explicit = readConfig(raw);
    const inheritedModel = this.state.defaults.model;
    const unavailable = Boolean(
      inheritedModel && this.state.data && !this.model(inheritedModel),
    );
    const model = explicit.model || (unavailable ? "" : inheritedModel);
    if (explicit.effort) return { ...explicit, model };
    const selected = this.model(model);
    const preferred =
      unavailable && !explicit.model ? "" : this.state.defaults.effort;
    const effort = !preferred
      ? ""
      : !this.state.data
        ? preferred
        : selected?.supportedReasoningEfforts.some(
              (choice) => choice.reasoningEffort === preferred,
            )
          ? preferred
          : (selected?.defaultReasoningEffort ?? "");
    return { ...explicit, model, effort };
  }
  dispose() {
    this.offSetup?.();
    this.abort?.abort();
    this.abort = undefined;
  }
  private model(model: string) {
    return catalogModel(model, this.state.data);
  }
  private readDefaults(): ProviderDefaults {
    try {
      const value: unknown = JSON.parse(
        this.storage.get(STORAGE_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        (value as { version?: unknown }).version === 1 &&
        typeof (value as { model?: unknown }).model === "string" &&
        typeof (value as { effort?: unknown }).effort === "string"
      )
        return Object.freeze({
          model: readConfig(value).model,
          effort: (value as { effort: string }).effort,
        });
    } catch {
      // Malformed local preferences follow Codex's recommendation.
    }
    return Object.freeze({ model: "", effort: "" });
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];

/** The catalog's models, for the picker; it adds Codex's own default. */
const choices = (data?: Catalog) =>
  data?.models.map((model) => ({
    id: model.model,
    label: model.displayName,
    description: model.description,
  })) ?? [];
const catalogModel = (model: string, data?: Catalog) => {
  if (!data) return undefined;
  const resolved = resolveModel(model, data.models);
  return data.models.find((choice) => choice.model === resolved);
};
const providerDefaultLabel = (model: string, data?: Catalog) => {
  const selected = catalogModel(model, data);
  const name = selected?.displayName || selected?.model;
  return name || model || "Recommended";
};
const codexDefaultEffortLabel = (effort: string, model?: Model) => {
  const resolved = effort || model?.defaultReasoningEffort;
  return resolved ? effortName(resolved) : "Automatic";
};
const thinkingOptions = (
  effort: string,
  effectiveEffort: string,
  selected?: Model,
  catalog?: Catalog,
) => {
  const supported = selected?.supportedReasoningEfforts ?? [];
  return [
    {
      value: "",
      label: `${codexDefaultEffortLabel(effectiveEffort, selected)} · Default`,
    },
    ...(effort &&
    !supported.some((candidate) => candidate.reasoningEffort === effort)
      ? [
          {
            value: effort,
            label: catalog
              ? `${effortName(effort)} (unavailable)`
              : effortName(effort),
          },
        ]
      : []),
    ...supported.map((candidate) => ({
      value: candidate.reasoningEffort,
      label: effortName(candidate.reasoningEffort),
    })),
  ];
};
/** A model's choice also resets the effort to that model's default. */
const modelChange = (model: string, data?: Catalog) => ({
  model,
  effort:
    data?.models.find((candidate) => candidate.model === model)
      ?.defaultReasoningEffort ?? "",
});

function CodexSignIn({
  login,
  step,
  checking,
  check,
  disabled,
}: {
  login: CodexSetup;
  step: "install" | "login";
  checking: boolean;
  check(): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { running, output } = useSyncExternalStore(
    login.subscribe,
    login.snapshot,
  );
  const action = step === "install" ? "Install Codex" : "Sign in";
  // A step's process ends before the check that follows it, which may still
  // find the step needed; until it answers, neither button starts another.
  return (
    <>
      <Button
        size="sm"
        variant="prominent"
        disabled={disabled || !!running || checking}
        focusableWhenDisabled
        onClick={() => {
          if (login.snapshot().running) return;
          setOpen(true);
          void login.run(step);
        }}
      >
        {action}
      </Button>
      <Dialog
        open={open}
        title={step === "install" ? "Set up Codex" : "Sign in to Codex"}
        description={step === "login" ? "Continue in your browser." : undefined}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void login.cancel();
        }}
      >
        <section className="grid gap-2">
          {step === "install" && (
            <p role="status" className="m-0">
              {checking && !running
                ? "Checking Codex…"
                : "Codex is not installed."}
            </p>
          )}
          {/* One button per slot, so focus stays put as Install becomes
              Sign in and Cancel becomes Check again. */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="prominent"
              size="sm"
              loading={running === step || (!running && checking)}
              disabled={disabled || (!!running && running !== step)}
              onClick={() => void login.run(step)}
            >
              {action}
            </Button>
            {(step !== "login" || running) && (
              <Button
                variant="ghost"
                disabled={!running && checking}
                focusableWhenDisabled
                onClick={() => void (running ? login.cancel() : check())}
              >
                {running ? "Cancel" : "Check again"}
              </Button>
            )}
          </div>
          {step === "install" && (
            <p className="m-0 text-body-sm text-subtle">
              Downloads Buzz's own copy of Codex (about 130 MB) from
              releases.openai.com and keeps it on the latest release. It does
              not change the <code>codex</code> in your terminal, and uses the
              same sign-in and settings.
            </p>
          )}
          {output && (
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
                      {output}
                    </pre>
                  ),
                },
              ]}
            />
          )}
        </section>
      </Dialog>
    </>
  );
}

export function createTabs(
  provider: CodexProvider,
  runtime: CodexRuntime,
  spawn: Spawn,
  setup: CodexSetup,
) {
  const login = setup;

  function useProvider() {
    const state = useSyncExternalStore(
      provider.subscribe,
      provider.snapshot,
      provider.snapshot,
    );
    useEffect(() => {
      if (state.readiness === "checking" && !state.checking)
        void provider.check();
    }, [state.readiness, state.checking]);
    return state;
  }

  function CreateModel({
    config,
    onChange,
    ...props
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { data, checking, error, defaults: providerDefaults } = useProvider();
    // The setup's status holds through the provider's next check, so the
    // button, and its focus, stays put as Install Codex becomes Sign in.
    const { status } = useSyncExternalStore(
      login.subscribe,
      login.snapshot,
      login.snapshot,
    );
    const retry = () => void provider.check();
    const step =
      status?.state === "missing" || error === NOT_INSTALLED
        ? "install"
        : status?.state === "signed-out" || error === SIGN_IN_ERROR
          ? "login"
          : undefined;
    const field = useRef<HTMLDivElement>(null);
    const hadStep = useRef(false);
    const handoff = useRef(false);
    // Setup's dialog and button leave once Codex is ready; focus they held
    // moves to the model field, not to the page. The field takes it once
    // the models load, as it is disabled until then.
    useEffect(() => {
      const unfocused = () =>
        !document.activeElement || document.activeElement === document.body;
      if (step) handoff.current = false;
      else if (hadStep.current) handoff.current = unfocused();
      hadStep.current = Boolean(step);
      if (!handoff.current || checking) return;
      handoff.current = false;
      if (unfocused())
        field.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
    }, [step, checking]);
    if (step)
      return (
        <CodexSignIn
          login={login}
          step={step}
          checking={checking}
          check={retry}
          disabled={props.disabled}
        />
      );
    return (
      <div ref={field} className="contents">
        <CreateModelChoices
          {...props}
          models={choices(data)}
          value={current.model}
          defaultModel={catalogModel(providerDefaults.model, data)?.model ?? ""}
          defaultLabel={providerDefaultLabel(providerDefaults.model, data)}
          defaultDescription="Following the provider's model default"
          loading={checking}
          error={error}
          retry={retry}
          onChange={(model) =>
            onChange(readConfig({ ...current, ...modelChange(model, data) }))
          }
        />
      </div>
    );
  }

  function CreateThinking({
    config,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    const current = readConfig(config);
    const { data, checking } = useProvider();
    const { effort } = current;
    const effective = provider.resolve({ ...current, effort: "" });
    const selected = catalogModel(effective.model, data);
    useEffect(() => {
      if (disabled || checking || !data || !effort || !selected) return;
      if (
        !selected.supportedReasoningEfforts.some(
          (choice) => choice.reasoningEffort === effort,
        )
      )
        onChange(readConfig({ ...config, effort: "" }));
    }, [checking, config, data, disabled, effort, onChange, selected]);
    const efforts = thinkingOptions(
      current.effort,
      effective.effort,
      selected,
      data,
    );
    return (
      <Select
        label="Thinking"
        valueLabel={
          current.effort
            ? undefined
            : codexDefaultEffortLabel(effective.effort, selected)
        }
        valueSuffix={current.effort ? undefined : " · Default"}
        variant="compact"
        value={current.effort}
        groups={[{ label: "", options: efforts }]}
        disabled={disabled || checking || !selected}
        onValueChange={(effort) => onChange(readConfig({ ...current, effort }))}
      />
    );
  }

  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    const state = useProvider();
    const [error, setError] = useState("");
    return (
      <>
        <ModelPicker
          includeDefault={false}
          resetLabel="Use Codex recommended"
          compact
          groupByFamily
          label="Codex default model"
          loading={state.checking}
          models={choices(state.data).map((choice) => ({
            ...choice,
            efforts: [
              { id: "", label: "Automatic" },
              ...(
                catalogModel(choice.id, state.data)
                  ?.supportedReasoningEfforts ?? []
              ).map((level) => ({
                id: level.reasoningEffort,
                label: effortName(level.reasoningEffort),
              })),
            ],
          }))}
          effort={state.defaults.effort}
          effortLabel={
            state.defaults.effort
              ? effortName(state.defaults.effort)
              : "Automatic"
          }
          onEffortChange={(model, effort) => {
            provider.saveDefaults({ model, effort }).then(
              () => setError(""),
              (reason) => setError(String(reason)),
            );
          }}
          value={state.defaults.model}
          defaultModel={catalogModel("", state.data)?.model}
          defaultLabel={providerDefaultLabel("", state.data)}
          onConfigure={onConfigure}
          onChange={(model) => {
            provider.saveDefaults({ model, effort: "" }).then(
              () => setError(""),
              (reason) => setError(String(reason)),
            );
          }}
        />
        {error && <span role="alert">{error}</span>}
      </>
    );
  }

  function ProviderDialogBody({ onClose }: { onClose(): void }) {
    const defaultsForm = useId();
    const state = useProvider();
    const { data, error, checking } = state;
    const installing = useSyncExternalStore(
      setup.subscribe,
      setup.snapshot,
      setup.snapshot,
    );
    const [draft, setDraft] = useState(state.defaults);
    const [saveError, setSaveError] = useState("");
    const [savingDefaults, setSavingDefaults] = useState(false);
    const action =
      error === NOT_INSTALLED
        ? ({ step: "install", label: "Install Codex" } as const)
        : error === SIGN_IN_ERROR
          ? ({ step: "login", label: "Sign in" } as const)
          : undefined;
    useEffect(() => setDraft(state.defaults), [state.defaults]);
    const selected = catalogModel(draft.model, data);
    const efforts = [
      {
        value: "",
        label: `${codexDefaultEffortLabel("", selected)} · Default`,
      },
      ...(draft.effort &&
      !selected?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === draft.effort,
      )
        ? [
            {
              value: draft.effort,
              label: `${effortName(draft.effort)} (unavailable)`,
            },
          ]
        : []),
      ...(selected?.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        label: effortName(effort.reasoningEffort),
      })) ?? []),
    ];
    return (
      <div className="grid gap-6">
        {installing.notice && (
          <p role="status" className="m-0 text-body-sm">
            {installing.notice}
          </p>
        )}
        <div className="grid gap-2" hidden={state.readiness === "ready"}>
          {installing.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="m-0 text-body-sm">
                {installing.running === "login"
                  ? "Waiting for Codex sign-in…"
                  : "Installing Codex…"}
              </p>
            </div>
          ) : checking ? (
            <p role="status" className="m-0">
              Checking Codex…
            </p>
          ) : error ? (
            <p role="alert" className="m-0 text-body-sm text-primary">
              <strong>{error}</strong>
            </p>
          ) : null}
          {action?.step === "install" && !installing.running && (
            <p className="m-0 text-body-sm text-subtle">
              Downloads Buzz's own copy of Codex (about 130 MB) from
              releases.openai.com and keeps it on the latest release. It does
              not change the <code>codex</code> in your terminal, and uses the
              same sign-in and settings.
            </p>
          )}
          {installing.output && (
            <div
              role="log"
              aria-label="Setup output"
              className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-body-sm text-subtle"
            >
              {installing.output}
            </div>
          )}
        </div>
        <form
          id={defaultsForm}
          className="grid gap-3"
          hidden={state.readiness !== "ready"}
          onSubmit={(event) => {
            event.preventDefault();
            if (savingDefaults) return;
            setSaveError("");
            setSavingDefaults(true);
            // Closes only once saved; else the draft stays to try again.
            provider
              .saveDefaults(draft)
              .then(onClose, (reason) => setSaveError(message(reason)))
              .finally(() => setSavingDefaults(false));
          }}
        >
          <Select
            label="Default thinking"
            valueLabel={
              draft.effort ? undefined : codexDefaultEffortLabel("", selected)
            }
            valueSuffix={draft.effort ? undefined : " · Default"}
            variant="preference"
            value={draft.effort}
            groups={[{ label: "", options: efforts }]}
            disabled={checking || !selected || savingDefaults}
            onValueChange={(effort) => setDraft({ ...draft, effort })}
          />
          {saveError && (
            <p role="alert" className="buzz-field-error">
              {saveError}
            </p>
          )}
        </form>
        <ProviderDialogActions>
          <Button
            onClick={() =>
              installing.running ? void setup.cancel() : onClose()
            }
          >
            Cancel
          </Button>
          {state.readiness === "ready" ? (
            <Button
              type="submit"
              form={defaultsForm}
              variant="prominent"
              loading={savingDefaults}
              disabled={
                JSON.stringify(draft) === JSON.stringify(state.defaults)
              }
              focusableWhenDisabled
            >
              Save defaults
            </Button>
          ) : action && !installing.running && !checking ? (
            <Button
              autoFocus
              variant="prominent"
              onClick={() => void setup.run(action.step)}
            >
              {action.label}
            </Button>
          ) : null}
        </ProviderDialogActions>
      </div>
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
        onChange={(instructions) =>
          onChange(readConfig({ ...current, instructions }))
        }
      />
    );
  }

  /** One conversation's Codex thread, read on open and on Refresh. A refresh
   * keeps the last result in place until the new one arrives. */
  function TranscriptView({
    agent,
    conversation,
    openConversation,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation: SavedConversation;
    openConversation: AgentViewProps<Config>["openConversation"];
  }) {
    const [read, setRead] = useState<Read>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit Refresh.
    useEffect(() => {
      const abort = new AbortController();
      setLoading(true);
      void readTranscript(
        spawn,
        { agent: { key: agent.key, name: agent.name }, ...conversation },
        abort.signal,
        (pubkey) => runtime.name(agent.key, pubkey),
      )
        .then(
          (transcript): Read =>
            transcript
              ? {
                  status: "ready",
                  transcript: {
                    ...transcript,
                    turns: runtime.prompts(agent.key).shown(transcript.turns),
                  },
                }
              : { status: "missing" },
          (reason): Read => ({ status: "error", error: message(reason) }),
        )
        .then((next) => {
          if (abort.signal.aborted) return;
          setRead(next);
          setLoading(false);
        });
      return () => abort.abort();
    }, [conversation, attempt]);
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
            Reading the Codex session…
          </p>
        ) : read.status === "missing" ? (
          <p className="m-0 text-body-sm text-subtle">
            Codex has no history for this conversation on this computer. Its
            session may have been deleted.
          </p>
        ) : read.status === "error" ? (
          <p role="alert" className="m-0">
            Could not read the Codex session: {read.error}
          </p>
        ) : (
          <ActivityTranscript
            transcript={read.transcript}
            agentName={agent.name}
            openConversation={openConversation}
            state={() => (read.transcript.working ? "working" : undefined)}
            before={
              read.transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
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
    const sessions = useSyncExternalStore(runtime.subscribe, () =>
      runtime.sessions(agent.key),
    );
    const conversations = runtime.conversations(agent.key);
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      conversations,
      conversation,
      (place, signal) =>
        runtime.find({ key: agent.key, name: agent.name }, place, signal),
      (channelId) => runtime.channelLabel(agent.key, channelId),
    );
    const recent = conversations
      .filter((item) => item.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    const saved = new Set(conversations.map((row) => row.key));
    const views = new Map(sessions.map((view) => [view.key, view]));
    const unbound = sessions.filter((view) => !saved.has(view.key));
    const detail = (text: string, status?: string) =>
      status !== "Working" ? (
        <p className="m-0 whitespace-pre-wrap break-words text-body-sm text-subtle">
          {text}
        </p>
      ) : (
        <details className={activityStyles.details}>
          <summary className="text-body-sm text-subtle">
            <CaretRightIcon size={14} aria-hidden="true" />
            <span>Latest activity</span>
          </summary>
          <pre className={`${activityStyles.detail} text-mono`}>{text}</pre>
        </details>
      );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="Codex"
            session={here}
            searching={searching}
            error={lookupError}
            status={here && views.get(here.key)?.status}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent conversations" />
          <SettingsGroup layout="form">
            {recent.length || unbound.length ? (
              <ul className={activityStyles.list}>
                {/* Work that failed before Codex started a thread has no binding. */}
                {unbound.map((view) => (
                  <li key={view.key} className={activityStyles.entry}>
                    <p className="m-0 break-words text-body-sm">
                      <code>{view.key}</code> · {view.status}
                    </p>
                    {view.detail && detail(view.detail, view.status)}
                  </li>
                ))}
                {recent.map((conversation) => {
                  const view = views.get(conversation.key);
                  return (
                    <li key={conversation.key} className={activityStyles.entry}>
                      <div className={activityStyles.row}>
                        <div className={activityStyles.copy}>
                          <ConversationName
                            session={conversation}
                            title={label(conversation)}
                            className="text-label-sm"
                          />
                          <p className="m-0 text-body-sm text-subtle">
                            {[
                              conversation.root
                                ? `Thread ${conversation.root.slice(0, 8)}`
                                : "Channel",
                              view?.status,
                              conversation.at
                                ? formatItemTimestamp(conversation.at / 1000, {
                                    withTime: true,
                                  })
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="subtle"
                          size="sm"
                          aria-label={`View transcript: ${label(conversation)}`}
                          onClick={() => show(conversation)}
                        >
                          View transcript
                        </Button>
                      </div>
                      {view?.detail && detail(view.detail, view.status)}
                    </li>
                  );
                })}
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
              openConversation={openConversation}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  /** What the agent runs with. Saving applies to the next turn. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const {
      data,
      error: catalogError,
      checking,
      defaults: providerDefaults,
    } = useProvider();
    useEffect(() => {
      setDraft(readConfig(agent.config));
    }, [agent.config]);
    const effective = provider.resolve({ ...draft, effort: "" });
    const selected = catalogModel(effective.model, data);
    const efforts = thinkingOptions(
      draft.effort,
      effective.effort,
      selected,
      data,
    );
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const settings = readConfig(draft);
        if (!validWorkspace(settings.workspace))
          throw new Error("Enter an absolute or ~/… workspace path.");
        await save(settings);
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const customization = (
      <>
        {catalogError && (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="m-0">
              {catalogError}
            </p>
            <Button
              variant="ghost"
              disabled={checking}
              focusableWhenDisabled
              onClick={() => void provider.check()}
            >
              Check again
            </Button>
          </div>
        )}
        <ModelPicker
          allowCustomModel={false}
          models={choices(data)}
          value={draft.model}
          defaultModel={catalogModel(providerDefaults.model, data)?.model ?? ""}
          defaultLabel={providerDefaultLabel(providerDefaults.model, data)}
          defaultDescription="Following the provider's model default"
          loading={checking}
          disabled={saving}
          onChange={(model) =>
            setDraft({ ...draft, ...modelChange(model, data) })
          }
        />
        <Select
          label="Thinking"
          valueLabel={
            draft.effort
              ? undefined
              : codexDefaultEffortLabel(effective.effort, selected)
          }
          valueSuffix={draft.effort ? undefined : " · Default"}
          variant="preference"
          value={draft.effort}
          groups={[{ label: "", options: efforts }]}
          disabled={checking || saving || !selected}
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
              {customization}
            </SettingsGroup>
            <AgentInstructions
              value={draft.instructions}
              disabled={saving}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <Field
              label="Workspace"
              description="Codex starts here with full access to your files and network. Buzz tools run inside the app. Inherited MCP/Apps/plugin tools are disabled."
            >
              <Input
                value={draft.workspace}
                placeholder="~/.buzz"
                disabled={saving}
                onValueChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </Field>
            <Select
              label="Sessions"
              variant="preference"
              value={draft.scope}
              groups={SCOPES}
              disabled={saving}
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
