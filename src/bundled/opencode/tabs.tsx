// OpenCode's New agent choices and agent settings: which opencode agent it
// runs as, its instructions, workspace and sessions. Models are picked per
// mention; opencode's agents are listed from it.
import { useEffect, useId, useState } from "react";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { validWorkspace } from "../codex/config";
import type { Modes } from "./models";
import { type Config, DEFAULT_CONFIG, config as readConfig } from "./runtime";

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

type Read =
  | { status: "loading" }
  | { status: "ready"; value: Modes }
  | { status: "error"; error: string };

/** opencode's agents, read once per mount. */
function useModes(read: (() => Promise<Modes>) | undefined): Read {
  const [state, setState] = useState<Read>({ status: "loading" });
  useEffect(() => {
    if (!read) {
      setState({ status: "ready", value: { current: "", modes: [] } });
      return;
    }
    let current = true;
    read().then(
      (value) => current && setState({ status: "ready", value }),
      (error: unknown) =>
        current && setState({ status: "error", error: message(error) }),
    );
    return () => {
      current = false;
    };
  }, [read]);
  return state;
}

export function createTabs({
  modes,
}: Readonly<{
  /** Lists opencode's agents; absent where opencode can't be started. */
  modes?: () => Promise<Modes>;
}>) {
  /** The opencode agent turns run as: opencode's default, or one it lists. */
  function ModeField({
    value,
    disabled = false,
    onChange,
  }: Readonly<{
    value: string;
    disabled?: boolean;
    onChange(mode: string): void;
  }>) {
    const listed = useModes(modes);
    const offered = listed.status === "ready" ? listed.value.modes : [];
    const fallback =
      listed.status === "ready" && listed.value.current
        ? listed.value.current
        : "opencode default";
    return (
      <Select
        label="OpenCode agent"
        variant="preference"
        value={value}
        {...(!value ? { valueLabel: fallback } : {})}
        disabled={disabled}
        {...(listed.status === "error"
          ? { description: `Could not list opencode's agents: ${listed.error}` }
          : listed.status === "loading"
            ? { description: "Loading opencode's agents…" }
            : {})}
        groups={[
          {
            label: "",
            options: [
              { value: "", label: `${fallback} · Default` },
              // A saved agent opencode no longer lists, or not yet read.
              ...(value && !offered.some((mode) => mode.id === value)
                ? [
                    {
                      value,
                      label:
                        listed.status === "ready"
                          ? `${value} (unavailable)`
                          : value,
                    },
                  ]
                : []),
              ...offered.map((mode) => ({ value: mode.id, label: mode.label })),
            ],
          },
        ]}
        onValueChange={onChange}
      />
    );
  }

  /** The opencode agent, workspace and instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    // Unnormalized, so the workspace can be cleared and retyped; the runtime
    // falls back to the default for a blank or relative path.
    const current: Config = { ...DEFAULT_CONFIG, ...config };
    const workspace = current.workspace.trim();
    return (
      <>
        <ModeField
          value={current.mode}
          disabled={disabled}
          onChange={(mode) => onChange({ ...current, mode })}
        />
        <Field
          label="Workspace"
          description="The folder opencode works in. Use ~/ for your home folder."
          {...(workspace && !validWorkspace(workspace)
            ? { error: "Enter an absolute or ~/… workspace path." }
            : {})}
        >
          <Input
            value={current.workspace}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ ...current, workspace: value })
            }
          />
        </Field>
        <AgentInstructions
          creation
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
      </>
    );
  }

  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
        if (!validWorkspace(workspace))
          throw new Error("Enter an absolute or ~/… workspace path.");
        await save({ ...draft, workspace });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <form
        id={form}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <SettingsGroup>
          {settingsHost?.typeControl?.(configChanged)}
          <ModeField
            value={draft.mode}
            onChange={(mode) => setDraft({ ...draft, mode })}
          />
        </SettingsGroup>
        <AgentInstructions
          value={draft.instructions}
          disabled={false}
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        <Field
          label="Workspace"
          description="The folder opencode works in. Use ~/ for your home folder."
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
        <AgentSaveButton form={form} saving={saving} disabled={!changed} />
        {settingsContent}
      </form>
    );
  }

  return { Create, SettingsTab };
}
