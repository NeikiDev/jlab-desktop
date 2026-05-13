import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppError,
  WatcherEvent,
  WatcherRunState,
  WatcherRuntimeState,
  WatcherSettings,
} from "../types";
import {
  appErrorToUserText,
  isAppError,
  subscribeWatcher,
  watcherAcknowledgeWarning,
  watcherGetRuntimeState,
  watcherGetSettings,
  watcherSetEnabled,
} from "../api";
import WatcherFirstEnableModal from "./WatcherFirstEnableModal";
import WatcherStatusCard, { type ReviewItem } from "./WatcherStatusCard";
import WatcherFoldersList from "./WatcherFoldersList";
import WatcherSettingsList from "./WatcherSettingsList";
import { cn } from "../cn";

interface Props {
  onBack: () => void;
  apiOnline: boolean;
}

const RUNTIME_DEFAULT: WatcherRuntimeState = {
  runState: "off",
  queueDepth: 0,
  currentFile: null,
  currentStartedMs: null,
};

export default function WatcherPanel({ onBack, apiOnline }: Props) {
  const [settings, setSettings] = useState<WatcherSettings | null>(null);
  const [runtime, setRuntime] = useState<WatcherRuntimeState>(RUNTIME_DEFAULT);
  const [showWarning, setShowWarning] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReviewItem[]>([]);
  const recentRef = useRef<ReviewItem[]>([]);

  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await watcherGetRuntimeState());
    } catch (e) {
      console.warn("[WatcherPanel] runtime fetch failed", e);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    watcherGetSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[WatcherPanel] settings load failed", e);
          setError(String((e as { message?: string })?.message ?? e));
        }
      });
    void refreshRuntime();
    return () => {
      cancelled = true;
    };
  }, [refreshRuntime]);

  useEffect(() => {
    const off = subscribeWatcher((ev: WatcherEvent) => {
      switch (ev.type) {
        case "state-changed":
          setRuntime((r) => ({ ...r, runState: ev.runState }));
          break;
        case "queue-updated":
          setRuntime((r) => ({ ...r, queueDepth: ev.depth }));
          break;
        case "scan-started":
          setRuntime((r) => ({
            ...r,
            runState: "scanning",
            currentFile: ev.fileName,
            currentStartedMs: Date.now(),
          }));
          break;
        case "scan-completed": {
          const item: ReviewItem = {
            fileName: ev.fileName,
            path: ev.path,
            topSeverity: ev.topSeverity,
            signatureCount: ev.signatureCount,
            flagged: ev.flagged,
            action: ev.action,
            at: Date.now(),
          };
          recentRef.current = [item, ...recentRef.current].slice(0, 20);
          setRecent(recentRef.current);
          setRuntime((r) => ({
            ...r,
            currentFile: null,
            currentStartedMs: null,
            runState: r.queueDepth > 0 ? "scanning" : "idle",
          }));
          break;
        }
        case "error":
          setError(ev.message);
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  const handleError = useCallback((raw: unknown) => {
    const text = isAppError(raw)
      ? appErrorToUserText(raw as AppError)
      : String((raw as { message?: string })?.message ?? raw);
    setError(text);
  }, []);

  const onToggleMaster = useCallback(async () => {
    if (!settings) return;
    if (!settings.enabled && !settings.warningAcknowledged) {
      setShowWarning(true);
      return;
    }
    try {
      const updated = await watcherSetEnabled(!settings.enabled);
      setSettings(updated);
      void refreshRuntime();
    } catch (e) {
      handleError(e);
    }
  }, [settings, handleError, refreshRuntime]);

  const onConfirmWarning = useCallback(async () => {
    try {
      const acked = await watcherAcknowledgeWarning();
      setSettings(acked);
      const updated = await watcherSetEnabled(true);
      setSettings(updated);
      setShowWarning(false);
      void refreshRuntime();
    } catch (e) {
      handleError(e);
      setShowWarning(false);
    }
  }, [handleError, refreshRuntime]);

  const status = useMemo(
    () => deriveStatus(settings, runtime.runState, apiOnline),
    [settings, runtime.runState, apiOnline],
  );
  const apiDown = (settings?.enabled ?? false) && !apiOnline;

  if (!settings) {
    return (
      <div className="flex w-full animate-rise-in flex-col gap-4">
        <BackLink onBack={onBack} />
        <div className="surface px-4 py-6 text-center text-[13px] text-text-muted">
          Loading watcher settings...
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full animate-rise-in flex-col gap-3.5">
      <BackLink onBack={onBack} />
      <HeroCard
        enabled={settings.enabled}
        folderCount={settings.folders.length}
        status={status}
        showInfo={showHowItWorks}
        onInfoToggle={() => setShowHowItWorks((v) => !v)}
        onToggle={() => void onToggleMaster()}
      />

      {error && (
        <ErrorBar message={error} onDismiss={() => setError(null)} />
      )}

      {apiDown && <ApiDownBanner holdEnabled={settings.holdUntilScanned} />}

      <div
        className={cn(
          "flex flex-col gap-3.5 transition-[opacity,filter] duration-base ease-out",
          !settings.enabled && "opacity-65 saturate-[0.4]",
        )}
        aria-disabled={!settings.enabled}
      >
        {!settings.enabled && (
          <div className="flex items-center gap-2.5 rounded-[var(--radius-sm)] border border-dashed border-border-faint bg-bg-elev/30 px-3.5 py-2.5 text-[13.5px] text-text-muted">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text-faint" />
            <span>
              Watcher is off. Changes below are saved but only take effect after you turn the watcher on.
            </span>
          </div>
        )}

        <WatcherStatusCard runtime={runtime} recent={recent} />

        <WatcherFoldersList
          folders={settings.folders}
          onChanged={async () => {
            try {
              const s = await watcherGetSettings();
              setSettings(s);
            } catch (e) {
              handleError(e);
            }
          }}
          onError={(m) => setError(m)}
        />

        <WatcherSettingsList
          settings={settings}
          onUpdated={setSettings}
          onError={(m) => setError(m)}
        />
      </div>

      {showWarning && (
        <WatcherFirstEnableModal
          onCancel={() => setShowWarning(false)}
          onConfirm={() => void onConfirmWarning()}
        />
      )}
    </div>
  );
}

type StatusTone = "off" | "idle" | "scanning" | "paused" | "api_down";

function deriveStatus(
  settings: WatcherSettings | null,
  runState: WatcherRunState,
  apiOnline: boolean,
): { label: string; tone: StatusTone } {
  if (!settings || !settings.enabled) return { label: "Off", tone: "off" };
  if (!apiOnline) return { label: "API offline", tone: "api_down" };
  if (runState === "scanning") return { label: "Scanning", tone: "scanning" };
  if (runState === "paused") return { label: "Paused", tone: "paused" };
  return { label: "Active", tone: "idle" };
}

interface HeroProps {
  enabled: boolean;
  folderCount: number;
  status: { label: string; tone: StatusTone };
  showInfo: boolean;
  onInfoToggle: () => void;
  onToggle: () => void;
}

function HeroCard({ enabled, folderCount, status, showInfo, onInfoToggle, onToggle }: HeroProps) {
  const subline = enabled
    ? folderCount === 0
      ? "On. Add a folder to start."
      : `Watching ${folderCount} folder${folderCount === 1 ? "" : "s"}.`
    : "Off. Turn on to auto-scan new .jar files.";

  return (
    <section className="frame flex flex-col gap-0 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          title={enabled ? "Turn folder watcher off" : "Turn folder watcher on"}
          className={cn(
            "relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer items-center rounded-full border transition-[background,border-color,box-shadow] duration-base ease-out",
            enabled
              ? "border-status-ok-edge bg-status-ok-soft shadow-[0_0_0_3px_var(--color-status-ok-soft)]"
              : "border-border-faint bg-bg-inset hover:border-border-strong",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute h-[18px] w-[18px] rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[transform,background] duration-base ease-out",
              enabled ? "left-[24px] bg-status-ok" : "left-[3px] bg-text-faint",
            )}
          />
        </button>

        <h2 className="m-0 text-[16px] font-semibold tracking-[-0.005em] text-text">
          Folder watcher
        </h2>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
            status.tone === "off"
              ? "border-border-faint text-text-faint"
              : status.tone === "paused"
                ? "border-sev-medium-edge text-sev-medium"
                : status.tone === "api_down"
                  ? "border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft text-sev-critical"
                  : "border-status-ok/40 text-status-ok",
          )}
        >
          {status.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-dim">
          {subline}
        </span>

        <button
          type="button"
          onClick={onInfoToggle}
          aria-expanded={showInfo}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-3 py-1.5 text-[12.5px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border hover:bg-bg-elev hover:text-text"
        >
          How it works
          <span aria-hidden="true">{showInfo ? "▴" : "▾"}</span>
        </button>
      </div>

      {showInfo && (
        <div className="mt-3 grid w-full gap-4 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/40 p-4 text-[13.5px] leading-[1.6] text-text-muted animate-fade-in min-[760px]:grid-cols-3">
          <HowPoint title="How">
            JLab listens to operating system events for the folders you pick. New <code>.jar</code> files are uploaded to the same scanner the manual scan uses, capped at twelve uploads per minute.
          </HowPoint>
          <HowPoint title="Not an antivirus">
            No driver, no kernel hooks, no on-access block. The watcher does not delete or kill anything by itself unless you turn on auto-delete.
          </HowPoint>
          <HowPoint title="Existing files">
            Files already in your folders when watching started are ignored. Use <strong>scan all now</strong> on a folder to scan them.
          </HowPoint>
        </div>
      )}
    </section>
  );
}

function HowPoint({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-text">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/40 px-3 py-1.5 text-[13px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border hover:bg-bg-elev/80 hover:text-text"
    >
      <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <path
          d="M8 3 4 6.5 8 10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Back
    </button>
  );
}

function ApiDownBanner({ holdEnabled }: { holdEnabled: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-4 py-3 text-[14px] text-text animate-fade-in">
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sev-critical text-bg"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M6 2v4M6 8.5v.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-[14px] font-semibold text-sev-critical">
          Scanner offline.
        </div>
        <div className="text-[13.5px] text-text-muted">
          JLab cannot reach jlab.threat.rip, so new files cannot be scanned
          until the service is back.{" "}
          {holdEnabled ? (
            <>
              New jars are still held with a{" "}
              <code className="text-text">.jlab-pending</code> suffix so they
              can't run, and any file matching a previously-known malicious
              hash is still auto-actioned.
            </>
          ) : (
            <>
              Any file matching a previously-known malicious hash is still
              auto-actioned.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorBar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-4 py-3 text-[14px] text-text animate-fade-in">
      <span className="min-w-0 break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded-[3px] border border-border-faint bg-bg-elev/60 px-3 py-1.5 text-[12.5px] text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border hover:text-text"
      >
        Dismiss
      </button>
    </div>
  );
}
