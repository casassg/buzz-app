import { Slider } from "@base-ui/react/slider";
import {
  useState,
  useRef,
  useLayoutEffect,
  type Ref,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Effort } from "../../agents/service";
import { Avatar } from "../../../shared/design-system/ui/Avatar";
import { EffortMesh } from "./EffortMesh";
import { useRubberTrack } from "./useRubberTrack";
import styles from "../ComposerModels.module.css";

export function EffortSlider({
  avatarSrc,
  name,
  chatScoped,
  model,
  efforts,
  resting,
  value,
  disabled,
  pick,
  thumb,
}: {
  name: string;
  chatScoped?: boolean;
  avatarSrc: string | undefined;
  model(level?: string): ReactNode;
  efforts: readonly Effort[];
  /** The effort the run uses without a pick, when known. */
  resting: string | undefined;
  value: string | undefined;
  disabled: boolean;
  pick(effort: string | undefined): void;
  thumb?: Ref<HTMLInputElement>;
}) {
  const [pointerMoving, setPointerMoving] = useState(false);
  const rubber = useRubberTrack(disabled);
  const tether = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const label = tether.current;
    if (!label) return;
    // Clamp to the measured label width, including longer model names/text sizes.
    const measure = () =>
      label.parentElement?.style.setProperty(
        "--tether-half",
        `${label.getBoundingClientRect().width / 2}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, []);
  const index = efforts.findIndex((effort) => effort.id === value);
  const set = index >= 0;
  const own = efforts.findIndex((effort) => effort.id === resting);
  const at = set ? index : Math.max(own, 0);
  const last = Math.max(efforts.length - 1, 1);
  const known = set || own >= 0;
  const level = known ? (efforts[at]?.label ?? "") : "Default";
  // A tap on the thumb's resting stop changes no value, so commits pick too.
  // Next-run choices clear at the default; chat choices remain explicit.
  const choose = (next: number) => {
    const effort = efforts[next]?.id;
    pick(!chatScoped && effort === resting ? undefined : effort);
  };
  return (
    <Slider.Root
      className={styles.slider}
      style={{ "--effort-progress": known ? at / last : 0 } as CSSProperties}
      data-unknown={known ? undefined : ""}
      data-pointer-moving={pointerMoving ? "" : undefined}
      value={at}
      min={0}
      max={efforts.length - 1}
      step={1}
      thumbAlignment="edge"
      disabled={disabled}
      onValueChange={(next, details) => {
        // Base UI's data-dragging includes a stationary track press.
        // Only real pointer movement should bypass the click transition.
        setPointerMoving(details.reason === "drag");
        choose(next);
      }}
      onValueCommitted={(next) => {
        setPointerMoving(false);
        choose(next);
      }}
    >
      {/* Keep model selection outside the slider drag target. */}
      <div className={styles.tetherRow}>
        <div className={styles.tetherAnchor} ref={tether}>
          <div className={styles.tetherSway} ref={rubber.label}>
            {model(level)}
          </div>
        </div>
      </div>
      <Slider.Control className={styles.control} {...rubber.handlers}>
        <Slider.Track className={styles.track} ref={rubber.track}>
          <Slider.Indicator
            className={styles.indicator}
            // Base UI ends the fill at the thumb center. Cover the whole
            // circular handle so the fill's rounded cap cannot leave a gap.
            style={{
              width:
                "calc(var(--thumb-width) + var(--composer-effort-position) * (100% - var(--thumb-width)))",
            }}
          >
            <EffortMesh avatarSrc={avatarSrc} effort={known ? at / last : 0} />
          </Slider.Indicator>
          {efforts.map((effort, stop) => (
            <span
              key={effort.id}
              className={styles.stop}
              data-filled={known && stop <= at ? "" : undefined}
              style={{ "--stop": stop / last } as CSSProperties}
            />
          ))}
          <Slider.Thumb
            className={styles.thumb}
            data-rubber-thumb=""
            style={{
              insetInlineStart:
                "calc(var(--thumb-width) / 2 + var(--composer-effort-position) * (100% - var(--thumb-width)))",
            }}
            inputRef={thumb}
            aria-label={
              chatScoped
                ? `Effort for ${name} in this chat`
                : `Effort for ${name}'s next run`
            }
            getAriaValueText={() => level}
          >
            <span
              className={`${styles.thumbFace} light`}
              data-color-mode="light"
              aria-hidden="true"
            >
              <span className={styles.thumbAvatar} title={name}>
                <Avatar
                  src={avatarSrc}
                  alt=""
                  fallback={name}
                  size="fill"
                  loading="eager"
                />
              </span>
            </span>
          </Slider.Thumb>
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
