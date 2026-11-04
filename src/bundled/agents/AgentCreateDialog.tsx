// Avatar selection above the agent identity and type-owned setup fields.
import { useId, useRef, useState } from "react";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
  NewAgent,
  AgentCreationRequest,
  AgentUpdateRequest,
} from "../../features/agents/service";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentAvatarPicker, type AvatarSelection } from "./AgentAvatarPicker";
import styles from "./AgentCreate.module.css";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useNamePrompt, useShake } from "./useNamePrompt";
import { MigrationPreview } from "./AgentSettingsHost";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// A failed save's error sits below the whole form, often out of view.
const reveal = (element: HTMLElement | null) => {
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
  const popup = element.closest<HTMLElement>(".buzz-dialog");
  const footer = popup?.querySelector<HTMLElement>(".buzz-dialog-actions");
  if (!popup || !footer) return;
  const covered =
    element.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
  if (covered > 0) popup.scrollTop += covered;
};

/** Use each registered provider's icon in creation and library cards. */
export function TypeIcon({
  type,
  size = 16,
}: {
  type: RegisteredAgentType | undefined;
  size?: number;
}) {
  const Icon = type?.icon ?? RobotIcon;
  return <Icon size={size} aria-hidden="true" />;
}

const startingConfig = (type: RegisteredAgentType | undefined) => {
  try {
    return type?.defaults().config;
  } catch {
    return undefined;
  }
};

export function AgentCreateDialog({
  agents,
  types,
  community,
  onClose,
  onCreated,
  request,
  onCreate,
  update,
}: {
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
  request?: AgentCreationRequest;
  onCreate?(input: NewAgent): Promise<Agent>;
  /** Edits `agent` instead, starting from its settings with the request's
   * changes. */
  update?: Readonly<{
    agent: Agent;
    request: AgentUpdateRequest;
    onSave(input: NewAgent): Promise<void>;
  }>;
}) {
  const edited = update?.agent;
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(
    update ? (update.request.name ?? update.agent.name) : (request?.name ?? ""),
  );
  const [avatar, setAvatar] = useState<AvatarSelection>(() =>
    update
      ? { kind: "image", picture: update.agent.picture ?? "" }
      : { kind: "gloopie", picture: randomAgentAvatar().url },
  );
  const [typeKey, setTypeKey] = useState(
    (update ? (update.request.type ?? update.agent.type) : request?.type) ??
      types[0]?.key ??
      "",
  );
  const type = types.find((item) => item.key === typeKey) ?? types[0];
  const migration = (item: RegisteredAgentType | undefined) => {
    if (!edited || !item || item.key === edited.type) return undefined;
    try {
      return agents.previewRetype(edited.key, item.key);
    } catch {
      return undefined;
    }
  };
  /** The agent's settings in `item`, with the requested instructions. */
  const seed = (item: RegisteredAgentType | undefined) => {
    if (!update) return startingConfig(item);
    const { agent, request } = update;
    const config =
      item?.key === agent.type
        ? agent.config
        : (migration(item)?.config ?? startingConfig(item));
    return request.instructions !== undefined && item?.adopt
      ? item.adopt({ instructions: request.instructions }, config)
      : config;
  };
  const [config, setConfig] = useState(() => seed(type));
  const preview = migration(type);
  const [dirty, setDirty] = useState(Boolean(update));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarRef = useRef<{ prepare(): Promise<string> }>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const namePrompt = useNamePrompt(nameField);
  const nameControl = useRef<HTMLDivElement>(null);
  useShake(nameControl, namePrompt.attempts);
  const form = useId();
  const Create = type?.Create;
  const Model = type?.CreateModel;
  const Thinking = type?.CreateThinking;
  const close = () => setOpen(false);
  const chooseModel = (item: RegisteredAgentType, next: unknown) => {
    setTypeKey(item.key);
    setConfig(next);
    setDirty(true);
    setError("");
  };
  const choose = (key: string) => {
    const item = types.find((candidate) => candidate.key === key);
    if (!item || key === type?.key) return;
    const next = seed(item);
    // Typed instructions follow a new agent to its new harness.
    const instructions = update
      ? undefined
      : type?.carry?.(config).instructions;
    chooseModel(
      item,
      instructions && item.adopt ? item.adopt({ instructions }, next) : next,
    );
  };
  const create = async () => {
    if (!type || pending || avatarBusy) return;
    if (!name.trim()) {
      namePrompt.prompt();
      return;
    }
    setPending(true);
    setError("");
    try {
      const picture =
        (await avatarRef.current?.prepare()) ??
        (avatar.kind === "emoji" ? "" : avatar.picture);
      const input = {
        type: type.key,
        name: name.trim(),
        ...(picture ? { picture } : {}),
        ...(config !== undefined ? { config } : {}),
      };
      if (update) await update.onSave(input);
      else onCreated(await (onCreate ? onCreate(input) : agents.create(input)));
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
      title={edited ? `Edit ${edited.name}` : "Create agent"}
      description={
        update
          ? `${update.request.requesterName} proposed these changes. Nothing changes until you save.`
          : request
            ? `${request.requesterName} requested this agent. Review its settings before creating it.`
            : undefined
      }
      size="default"
      height="content"
      chromeSpacing="padded"
      initialFocus={nameField}
      // A started draft only closes from the close button.
      dismissOnOutsideClick={!dirty}
      onEscape={() => {
        if (pending || avatarBusy) return true;
        return dirty || pending;
      }}
      preventClose={pending || avatarBusy}
      actions={
        <Button
          variant="primary"
          type="submit"
          form={form}
          loading={pending}
          disabled={avatarBusy || pending || !type}
        >
          {update ? "Save changes" : "Create agent"}
        </Button>
      }
    >
      <form
        id={form}
        className={styles.form}
        data-error={error ? "" : undefined}
        aria-label={edited ? `Edit ${edited.name}` : "New agent"}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className={styles.createStack}>
          <section aria-label="Identity" className={styles.profileIdentity}>
            <div>
              <AgentAvatarPicker
                name={name}
                selection={avatar}
                disabled={pending}
                community={community}
                onBusyChange={setAvatarBusy}
                onChange={(selection) => {
                  setAvatar(selection);
                  setDirty(true);
                  setError("");
                }}
                avatarRef={avatarRef}
              />
            </div>
          </section>
          <div>
            <Field
              label="Name"
              error={
                namePrompt.attempts
                  ? update
                    ? "Name the agent"
                    : "Add a name to create your agent"
                  : undefined
              }
            >
              <div ref={nameControl}>
                <Input
                  ref={nameField}
                  placeholder="Name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => {
                    setName(event.target.value);
                    namePrompt.named(event.target.value);
                    setDirty(true);
                    setError("");
                  }}
                />
              </div>
            </Field>
          </div>
          <section
            aria-label="AI configuration"
            className={styles.configuration}
          >
            <SettingsGroup>
              <PreferenceRow
                title="Harness"
                trailing={
                  <Select
                    label="Harness"
                    variant="compact"
                    align="end"
                    value={type?.key ?? ""}
                    leading={<TypeIcon type={type} size={20} />}
                    disabled={pending || types.length < 2}
                    groups={[
                      {
                        label: "",
                        options: types.map((item) => ({
                          value: item.key,
                          leading: <TypeIcon type={item} size={20} />,
                          label: item.remote
                            ? `${item.title} (hosted)`
                            : item.title,
                        })),
                      },
                    ]}
                    onValueChange={choose}
                  />
                }
              />
              {Model && (
                <PreferenceRow
                  title="Model"
                  trailing={
                    <Model
                      key={type.key}
                      config={config}
                      disabled={pending}
                      onChange={(next) => chooseModel(type, next)}
                    />
                  }
                />
              )}
              {Thinking && (
                <PreferenceRow
                  title="Thinking"
                  trailing={
                    <Thinking
                      key={type.key}
                      config={config}
                      disabled={pending}
                      onChange={(next) => chooseModel(type, next)}
                    />
                  }
                />
              )}
            </SettingsGroup>
          </section>
          {Create ? (
            <Create
              key={type.key}
              config={config}
              disabled={pending}
              onChange={(next) => {
                setConfig(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              {type?.remote
                ? "Its provider keeps its key and runs it, whether or not this app is open."
                : "Set it up after it is made."}
            </p>
          )}
          {preview && type && (
            <MigrationPreview
              source={types.find((item) => item.key === edited?.type)}
              target={type}
              preview={preview}
              discardDraft={false}
            />
          )}
        </div>
        {error && (
          <p
            key={error}
            ref={reveal}
            role="alert"
            className="m-0 text-body-sm text-danger"
          >
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
