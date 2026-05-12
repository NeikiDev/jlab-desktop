import { useEffect, useRef, useState } from "react";
import type {
  ActionMode,
  ActionThreshold,
  AlertThreshold,
  RescanInterval,
  WatcherSettings,
} from "../types";
import {
  watcherOpenQuarantineDir,
  watcherResetToDefaults,
  watcherSetAlertThreshold,
  watcherSetAutoAction,
  watcherSetAutoActionMode,
  watcherSetHold,
  watcherSetLaunchAtLogin,
  watcherSetMultipleCriticalsThreshold,
  watcherSetNotifications,
  watcherSetRescan,
  watcherSetStartMinimized,
  watcherSetTray,
} from "../api";
import {
  BellIcon,
  EyeOffIcon,
  FolderIcon,
  LockIcon,
  MinimizeIcon,
  PowerIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
} from "./WatcherIcons";
import { cn } from "../cn";

interface Props {
  settings: WatcherSettings;
  onUpdated: (s: WatcherSettings) => void;
  onError: (msg: string) => void;
}

const ALERT_OPTS: { value: AlertThreshold; label: string }[] = [
  { value: "critical_single", label: "1 critical" },
  { value: "multiple_criticals", label: "Multiple" },
  { value: "confirmed_families_only", label: "Families" },
];

const ACTION_THRESHOLD_OPTS: { value: ActionThreshold; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "multiple_criticals", label: "Multiple" },
  { value: "confirmed_families_only", label: "Families" },
];

const ACTION_MODE_OPTS: { value: ActionMode; label: string }[] = [
  { value: "quarantine", label: "Quarantine" },
  { value: "trash", label: "Trash" },
];

const RESCAN_OPTS: { value: RescanInterval; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "days_7", label: "7 days" },
  { value: "days_14", label: "14 days" },
  { value: "days_30", label: "30 days" },
];

const MULTI_COUNT_OPTS = [2, 3, 4];

export default function WatcherSettingsList({ settings, onUpdated, onError }: Props) {
  function handle<T>(fn: (v: T) => Promise<WatcherSettings>) {
    return async (v: T) => {
      try {
        onUpdated(await fn(v));
      } catch (e) {
        onError(String((e as { message?: string })?.message ?? e));
      }
    };
  }

  const multiCount = Math.min(4, Math.max(2, settings.multipleCriticalsThreshold || 2));
  const useMultiSelector =
    settings.alertThreshold === "multiple_criticals" ||
    settings.autoAction === "multiple_criticals";

  return (
    <section className="flex flex-col gap-2.5">
      <header className="flex items-center justify-between gap-2 px-1">
        <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
          Settings
        </h3>
        <span className="text-[11.5px] uppercase tracking-[0.08em] text-text-faint">
          {settings.enabled ? "Live" : "Saved"}
        </span>
      </header>

      <div className="grid gap-2.5 grid-cols-1 min-[600px]:grid-cols-2 min-[1180px]:grid-cols-3">
        <SwitchTile
          icon={<BellIcon />}
          title="Notifications"
          description="Show a native OS toast when a scan crosses your alert threshold. Hits inside a 4 second window combine into one toast."
          value={settings.notificationsEnabled}
          onChange={handle(watcherSetNotifications)}
        />

        <SegmentTile
          icon={<ShieldIcon />}
          title="Alert threshold"
          description="1 critical fires on any single match. Multiple fires when 2 to 4 criticals are matched. Families fires only when the server confirms a known malware family."
          value={settings.alertThreshold}
          options={ALERT_OPTS}
          onChange={handle(watcherSetAlertThreshold)}
        />

        <ActionTile
          threshold={settings.autoAction}
          mode={settings.autoActionMode}
          onThresholdChange={handle(watcherSetAutoAction)}
          onModeChange={handle(watcherSetAutoActionMode)}
          onError={onError}
        />

        {useMultiSelector && (
          <Tile
            icon={<ShieldIcon />}
            title="Multiple criticals count"
            description="How many critical signatures need to match in one scan before the multiple rule fires. Affects both the alert and the auto-action rule."
            tone="warn"
            active
          >
            <div className="inline-flex w-full gap-1 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset p-1">
              {MULTI_COUNT_OPTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => void handle(watcherSetMultipleCriticalsThreshold)(n)}
                  className={cn(
                    "flex-1 cursor-pointer rounded-[4px] px-2 py-2 text-[14px] font-semibold tabular-nums transition-[background,color] duration-fast ease-out",
                    multiCount === n
                      ? "bg-sev-high-soft text-sev-high"
                      : "text-text-muted hover:bg-bg-elev/60 hover:text-text",
                  )}
                >
                  {n}+
                </button>
              ))}
            </div>
          </Tile>
        )}

        <SwitchTile
          icon={<LockIcon />}
          title="Hold until scanned"
          description="While the scan runs, rename foo.jar to foo.jar.jlab-pending so Java launchers cannot load it. Restored once the scan clears."
          value={settings.holdUntilScanned}
          onChange={handle(watcherSetHold)}
        />

        <SegmentTile
          icon={<RefreshIcon />}
          title="Rescan after"
          description="Re-upload files in watched folders on a schedule. Signature definitions update over time, so a clean file could match later."
          value={settings.rescanInterval}
          options={RESCAN_OPTS}
          onChange={handle(watcherSetRescan)}
        />

        <SwitchTile
          icon={<MinimizeIcon />}
          title="Minimize to tray"
          description="Closing the window hides it into the system tray. The watcher keeps running. Quit fully from the tray menu."
          value={settings.minimizeToTray}
          onChange={handle(watcherSetTray)}
        />

        <SwitchTile
          icon={<EyeOffIcon />}
          title="Start minimized"
          description="On launch, the window stays hidden. The tray icon is the only entry point. Requires minimize to tray."
          value={settings.startMinimized}
          disabled={!settings.minimizeToTray}
          onChange={handle(watcherSetStartMinimized)}
        />

        <SwitchTile
          icon={<PowerIcon />}
          title="Launch at login"
          description="Start JLab Desktop automatically when you log in. Combine with start minimized for a quiet background watcher."
          value={settings.launchAtLogin}
          onChange={handle(watcherSetLaunchAtLogin)}
        />
      </div>

      <ResetFooter onUpdated={onUpdated} onError={onError} />
    </section>
  );
}

function ResetFooter({
  onUpdated,
  onError,
}: {
  onUpdated: (s: WatcherSettings) => void;
  onError: (msg: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!confirming) return;
    timerRef.current = window.setTimeout(() => setConfirming(false), 5000);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [confirming]);

  async function doReset() {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await watcherResetToDefaults();
      onUpdated(updated);
      setConfirming(false);
    } catch (e) {
      onError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/20 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-text">
          Reset watcher to defaults
        </span>
        <span className="m-0 mt-0.5 text-[13px] leading-[1.55] text-text-muted">
          Stops the watcher, clears every setting (including watched folders), and re-asks the warning the next time you turn it on.
        </span>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-3.5 py-2 text-[13px] font-medium text-text-muted transition-colors duration-fast ease-out hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void doReset()}
            disabled={busy}
            className="cursor-pointer rounded-[var(--radius-sm)] border border-sev-critical bg-sev-critical-soft px-3.5 py-2 text-[13px] font-semibold text-sev-critical transition-[background,color,transform] duration-fast ease-out hover:bg-sev-critical hover:text-bg active:translate-y-[1px]"
          >
            {busy ? "Resetting…" : "Yes, reset"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="shrink-0 cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-3.5 py-2 text-[13px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-sev-critical-edge hover:text-sev-critical"
        >
          Reset
        </button>
      )}
    </div>
  );
}

type Tone = "ok" | "warn" | "danger" | "neutral";

interface BaseTileProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  tone?: Tone;
  disabled?: boolean;
}

const ICON_CHIP: Record<Tone, string> = {
  ok:      "border-status-ok-edge bg-status-ok-soft text-status-ok",
  warn:    "border-sev-high-edge bg-sev-high-soft text-sev-high",
  danger:  "border-sev-critical-edge bg-sev-critical-soft text-sev-critical",
  neutral: "border-border-strong bg-bg-elev text-text",
};

const TILE_BG: Record<Tone, string> = {
  ok:      "bg-status-ok-soft",
  warn:    "bg-sev-high-soft",
  danger:  "bg-sev-critical-soft",
  neutral: "bg-bg-elev/30",
};

function Tile({ icon, title, description, children, active, danger, tone, disabled }: BaseTileProps) {
  const effectiveTone: Tone = danger ? "danger" : tone ?? (active ? "ok" : "neutral");
  const showActive = active || danger;

  return (
    <div
      className={cn(
        "frame flex flex-col gap-2.5 p-3 transition-[background] duration-base ease-out",
        disabled
          ? "opacity-55"
          : showActive
            ? TILE_BG[effectiveTone]
            : "hover:bg-bg-elev/30",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border",
            showActive
              ? ICON_CHIP[effectiveTone]
              : "border-border-faint bg-bg-elev/60 text-text-muted",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 text-[14px] font-semibold leading-[1.25] text-text tracking-[-0.005em]">
          {title}
        </span>
      </div>

      <div className="flex items-start">{children}</div>

      <p className="m-0 text-[13px] leading-[1.55] text-text-muted">{description}</p>
    </div>
  );
}

interface SwitchTileProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

function SwitchTile({ icon, title, description, value, disabled, onChange }: SwitchTileProps) {
  const [pending, setPending] = useState(false);
  return (
    <Tile
      icon={icon}
      title={title}
      description={description}
      active={value}
      tone="ok"
      disabled={disabled}
    >
      <div className="flex w-full items-center justify-between gap-3">
        <span
          className={cn(
            "text-[13px] font-semibold uppercase tracking-[0.06em]",
            value ? "text-status-ok" : "text-text-faint",
          )}
        >
          {value ? "On" : "Off"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-label={title}
          disabled={disabled || pending}
          onClick={async () => {
            setPending(true);
            try {
              onChange(!value);
            } finally {
              setPending(false);
            }
          }}
          className={cn(
            "relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full border transition-[background,border-color] duration-base ease-out",
            value
              ? "border-status-ok-edge bg-status-ok-soft"
              : "border-border-faint bg-bg-inset",
            (disabled || pending) && "cursor-not-allowed opacity-60",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute h-[16px] w-[16px] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[transform,background] duration-base ease-out",
              value ? "left-[21px] bg-status-ok" : "left-[3px] bg-text-faint",
            )}
          />
        </button>
      </div>
    </Tile>
  );
}

interface SegmentTileProps<T extends string> {
  icon: React.ReactNode;
  title: string;
  description: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  danger?: boolean;
}

interface ActionTileProps {
  threshold: ActionThreshold;
  mode: ActionMode;
  onThresholdChange: (t: ActionThreshold) => void;
  onModeChange: (m: ActionMode) => void;
  onError: (msg: string) => void;
}

function ActionTile({
  threshold,
  mode,
  onThresholdChange,
  onModeChange,
  onError,
}: ActionTileProps) {
  const isActive = threshold !== "off";
  const isTrash = isActive && mode === "trash";
  const isQuarantine = isActive && mode === "quarantine";
  const description =
    threshold === "off"
      ? "When the threshold is met, optionally take an automatic action. Default is to quarantine (move to the JLab data dir, recoverable)."
      : mode === "quarantine"
        ? "Move the file to <data dir>/quarantine/ so it cannot be loaded. Recoverable."
        : "Move the file to the OS trash. Recoverable until you empty it.";

  const tileTone: Tone = isTrash ? "danger" : isQuarantine ? "warn" : "neutral";
  const selectedThresholdClass = isTrash
    ? "bg-sev-critical-soft text-sev-critical"
    : isQuarantine
      ? "bg-sev-high-soft text-sev-high"
      : "bg-bg-elev text-text";

  return (
    <Tile
      icon={<TrashIcon />}
      title="Auto-action"
      description={description}
      active={isActive}
      tone={tileTone}
      danger={isTrash}
    >
      <div className="flex w-full flex-col gap-2">
        <div className="flex w-full flex-wrap gap-1 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset p-1">
          {ACTION_MODE_OPTS.map((o) => {
            const selected = mode === o.value;
            const selectedClass =
              o.value === "trash"
                ? "bg-sev-critical-soft text-sev-critical"
                : "bg-sev-high-soft text-sev-high";
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onModeChange(o.value)}
                disabled={!isActive}
                className={cn(
                  "min-w-0 flex-1 cursor-pointer rounded-[4px] px-2 py-2 text-[13px] font-semibold uppercase tracking-[0.04em] transition-[background,color] duration-fast ease-out",
                  selected
                    ? selectedClass
                    : "text-text-muted hover:bg-bg-elev/60 hover:text-text",
                  !isActive && "cursor-not-allowed opacity-50",
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <div className="flex w-full flex-wrap gap-1 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset p-1">
          {ACTION_THRESHOLD_OPTS.map((o) => {
            const selected = threshold === o.value;
            const isOff = o.value === "off";
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onThresholdChange(o.value)}
                className={cn(
                  "min-w-0 flex-1 cursor-pointer rounded-[4px] px-2 py-2 text-[13px] font-medium transition-[background,color] duration-fast ease-out",
                  selected
                    ? isOff
                      ? "bg-bg-elev text-text"
                      : selectedThresholdClass
                    : "text-text-muted hover:bg-bg-elev/60 hover:text-text",
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            void watcherOpenQuarantineDir().catch((e) =>
              onError(String((e as { message?: string })?.message ?? e)),
            );
          }}
          className="inline-flex w-full cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset px-3 py-2 text-left transition-[background,border-color,color] duration-fast ease-out hover:border-sev-high-edge hover:bg-sev-high-soft/40 hover:text-sev-high"
        >
          <span className="inline-flex items-center gap-2 text-[13px] font-medium text-text-muted">
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-text-dim" />
            Open quarantine folder
          </span>
          <span aria-hidden="true" className="text-[15px] leading-none text-text-faint">
            &rsaquo;
          </span>
        </button>
      </div>
    </Tile>
  );
}

function SegmentTile<T extends string>({
  icon,
  title,
  description,
  value,
  options,
  onChange,
  danger,
}: SegmentTileProps<T>) {
  const isOn = !danger && value !== "off";
  return (
    <Tile
      icon={icon}
      title={title}
      description={description}
      active={isOn}
      tone={isOn ? "ok" : "neutral"}
      danger={danger}
    >
      <div className="flex w-full flex-wrap gap-1 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset p-1">
        {options.map((o) => {
          const selected = value === o.value;
          const isOffOption = o.value === "off";
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={cn(
                "min-w-0 flex-1 cursor-pointer rounded-[4px] px-2 py-1.5 text-[12px] font-medium transition-[background,color] duration-fast ease-out",
                selected
                  ? danger
                    ? "bg-sev-critical-soft text-sev-critical"
                    : isOffOption
                      ? "bg-bg-elev text-text"
                      : "bg-status-ok-soft text-status-ok"
                  : "text-text-muted hover:bg-bg-elev/60 hover:text-text",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </Tile>
  );
}
