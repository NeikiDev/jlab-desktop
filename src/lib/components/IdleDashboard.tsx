import { useEffect, useMemo, useState } from "react";
import DropZone from "./DropZone";
import {
  historyCap,
  historyList,
  subscribeWatcher,
  watcherGetRuntimeState,
  watcherGetSettings,
} from "../api";
import type {
  HistoryEntry,
  Severity,
  WatcherRunState,
  WatcherSettings,
} from "../types";
import {
  BellIcon,
  LockIcon,
  RefreshIcon,
  TrashIcon,
} from "./WatcherIcons";
import { cn } from "../cn";
import { usePausableInterval } from "../usePausableInterval";

interface Props {
  onPick: (path: string) => void;
  onShowHistory: () => void;
  onShowWatcher: () => void;
}

const SEV_DOT: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
  info: "bg-sev-info",
};

const RECENT_LIMIT = 8;

function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 45) return s <= 1 ? "now" : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

export default function IdleDashboard({
  onPick,
  onShowHistory,
  onShowWatcher,
}: Props) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [cap, setCap] = useState<number>(100);
  const [now, setNow] = useState(() => Date.now());
  const [watcherSettings, setWatcherSettings] =
    useState<WatcherSettings | null>(null);
  const [watcherRunState, setWatcherRunState] =
    useState<WatcherRunState>("off");
  const [watcherCurrent, setWatcherCurrent] = useState<string | null>(null);
  const [watcherQueue, setWatcherQueue] = useState(0);
  const watcherEnabled = watcherSettings?.enabled ?? false;
  const watcherFolders = watcherSettings?.folders.length ?? 0;

  useEffect(() => {
    let cancelled = false;
    historyList()
      .then((entries) => {
        if (!cancelled) setHistory(entries);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    historyCap()
      .then((v) => {
        if (!cancelled && Number.isFinite(v) && v > 0) setCap(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  usePausableInterval(() => setNow(Date.now()), 60_000);

  useEffect(() => {
    let cancelled = false;
    watcherGetSettings()
      .then((s) => {
        if (!cancelled) setWatcherSettings(s);
      })
      .catch(() => {});
    watcherGetRuntimeState()
      .then((r) => {
        if (!cancelled) {
          setWatcherRunState(r.runState);
          setWatcherCurrent(r.currentFile);
          setWatcherQueue(r.queueDepth);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribeWatcher((ev) => {
      switch (ev.type) {
        case "state-changed":
          setWatcherRunState(ev.runState);
          setWatcherSettings((prev) =>
            prev ? { ...prev, enabled: ev.runState !== "off" } : prev,
          );
          break;
        case "scan-started":
          setWatcherRunState("scanning");
          setWatcherCurrent(ev.fileName);
          break;
        case "scan-completed":
          setWatcherCurrent(null);
          break;
        case "queue-updated":
          setWatcherQueue(ev.depth);
          break;
        default:
          break;
      }
    });
  }, []);

  const recent = useMemo(() => {
    if (!history) return null;
    return [...history].reverse().slice(0, RECENT_LIMIT);
  }, [history]);

  return (
    <div className="flex w-full animate-rise-in flex-col gap-5">
      <DashHeader />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <DropZone onPick={onPick} />
        <WatcherCard
          settings={watcherSettings}
          enabled={watcherEnabled}
          runState={watcherRunState}
          folders={watcherFolders}
          currentFile={watcherCurrent}
          queueDepth={watcherQueue}
          onClick={onShowWatcher}
        />
      </div>

      <RecentScansCard
        recent={recent}
        now={now}
        total={history?.length ?? 0}
        cap={cap}
        onClick={onShowHistory}
      />
    </div>
  );
}

function DashHeader() {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-bg-elev text-text"
        >
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
            <rect x="1" y="1" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="7.5" y="1" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="7.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="7.5" y="7.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </span>
        <h1 className="m-0 text-[18px] font-semibold tracking-[-0.005em] text-text">
          Overview
        </h1>
        <span className="hidden text-[14px] text-text-dim sm:inline">
          Local scan activity. Nothing leaves this device.
        </span>
      </div>
    </div>
  );
}

function RecentScansCard({
  recent,
  now,
  total,
  cap,
  onClick,
}: {
  recent: HistoryEntry[] | null;
  now: number;
  total: number;
  cap: number;
  onClick: () => void;
}) {
  if (recent === null) return <CardSkeleton title="Recent scans" />;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open scan history"
      className="frame group flex flex-col gap-3 p-4 text-left transition-colors duration-fast ease-out hover:bg-bg-elev/40 focus-visible:bg-bg-elev/40"
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
          <ClockIcon />
          Recent scans
        </span>
        <span className="inline-flex items-center gap-3">
          <span className="tnum text-[12px] uppercase tracking-[0.08em] text-text-dim">
            {total} / {cap}
          </span>
          <CardCta label="Open history" />
        </span>
      </div>

      {recent.length === 0 ? (
        <p className="m-0 py-2 text-[14px] text-text-dim">
          No scans yet. Drop a file above to start.
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-0 p-0 md:grid-cols-2">
          {recent.map((entry) => {
            const sev = (entry.topSeverity as Severity) ?? "info";
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 border-b border-border-faint py-1.5"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    SEV_DOT[sev],
                  )}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-text"
                  title={entry.fileName}
                >
                  {entry.fileName}
                </span>
                <span className="tnum shrink-0 text-[12px] text-text-dim">
                  {formatRelative(entry.scannedAt, now)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </button>
  );
}

function WatcherCard({
  settings,
  enabled,
  runState,
  folders,
  currentFile,
  queueDepth,
  onClick,
}: {
  settings: WatcherSettings | null;
  enabled: boolean;
  runState: WatcherRunState;
  folders: number;
  currentFile: string | null;
  queueDepth: number;
  onClick: () => void;
}) {
  const statusText =
    runState === "scanning"
      ? "Scanning"
      : runState === "paused"
        ? "Paused"
        : enabled
          ? folders === 0
            ? "On, no folders"
            : "Watching"
          : "Off";

  const dotClass =
    runState === "scanning"
      ? "bg-status-ok animate-status-pulse"
      : enabled
        ? "bg-status-ok animate-status-pulse"
        : "bg-text-faint";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open folder watcher"
      className="frame group flex h-full flex-col gap-4 p-5 text-left transition-colors duration-fast ease-out hover:bg-bg-elev/40 focus-visible:bg-bg-elev/40"
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-text-dim">
          <EyeIcon />
          Folder watcher
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn("h-2 w-2 rounded-full", dotClass)}
          />
          <span
            className={cn(
              "text-[12.5px] font-medium",
              enabled || runState === "scanning"
                ? "text-text"
                : "text-text-dim",
            )}
          >
            {statusText}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <MiniStat label="Folders" value={folders} />
        <MiniStat label="In queue" value={queueDepth} />
      </div>

      {currentFile && (
        <p
          className="m-0 truncate font-mono text-[12.5px] text-text-dim"
          title={currentFile}
        >
          {currentFile}
        </p>
      )}

      <SettingsSummary settings={settings} dim={!enabled} />

      <CardCta label="Open watcher" />
    </button>
  );
}

const RESCAN_LABEL: Record<string, string> = {
  off: "Off",
  days_7: "7 days",
  days_14: "14 days",
  days_30: "30 days",
};

function SettingsSummary({
  settings,
  dim,
}: {
  settings: WatcherSettings | null;
  dim: boolean;
}) {
  if (!settings) {
    return (
      <div className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/20 p-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-3 rounded-[2px] bg-text-faint/15" />
        ))}
      </div>
    );
  }

  const autoAction = settings.autoAction;
  const autoMode = settings.autoActionMode;
  const autoLabel =
    autoAction === "off"
      ? "Off"
      : autoMode === "trash"
        ? "Trash"
        : "Quarantine";
  const autoTone: SummaryTone =
    autoAction === "off"
      ? "off"
      : autoMode === "trash"
        ? "danger"
        : "warn";

  const rescanTone: SummaryTone =
    settings.rescanInterval === "off" ? "off" : "ok";

  const rows: SummaryRow[] = [
    {
      icon: <BellIcon className="h-3.5 w-3.5" />,
      label: "Notifications",
      value: settings.notificationsEnabled ? "On" : "Off",
      tone: settings.notificationsEnabled ? "ok" : "off",
    },
    {
      icon: <TrashIcon className="h-3.5 w-3.5" />,
      label: "Auto-action",
      value: autoLabel,
      tone: autoTone,
    },
    {
      icon: <LockIcon className="h-3.5 w-3.5" />,
      label: "Hold to scan",
      value: settings.holdUntilScanned ? "On" : "Off",
      tone: settings.holdUntilScanned ? "ok" : "off",
    },
    {
      icon: <RefreshIcon className="h-3.5 w-3.5" />,
      label: "Rescan",
      value: RESCAN_LABEL[settings.rescanInterval] ?? "Off",
      tone: rescanTone,
    },
  ];

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/30 p-2 transition-opacity duration-base ease-out",
        dim && "opacity-65",
      )}
    >
      {rows.map((r) => (
        <SummaryRowItem key={r.label} {...r} />
      ))}
    </div>
  );
}

type SummaryTone = "ok" | "warn" | "danger" | "off";

interface SummaryRow {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: SummaryTone;
}

const SUMMARY_TONE: Record<SummaryTone, string> = {
  ok:     "text-status-ok",
  warn:   "text-sev-high",
  danger: "text-sev-critical",
  off:    "text-text-faint",
};

const SUMMARY_ICON_TONE: Record<SummaryTone, string> = {
  ok:     "text-status-ok",
  warn:   "text-sev-high",
  danger: "text-sev-critical",
  off:    "text-text-dim",
};

function SummaryRowItem({ icon, label, value, tone }: SummaryRow) {
  return (
    <div className="flex items-center gap-2.5 px-1.5 py-1">
      <span className={cn("inline-flex shrink-0", SUMMARY_ICON_TONE[tone])}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-dim">
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 text-[12px] font-semibold uppercase tracking-[0.04em]",
          SUMMARY_TONE[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] uppercase tracking-[0.08em] text-text-dim">
        {label}
      </span>
      <span className="tnum text-[22px] font-semibold leading-none tracking-[-0.02em] text-text">
        {value}
      </span>
    </div>
  );
}

function CardCta({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="mt-auto inline-flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-text-dim transition-colors duration-fast ease-out group-hover:text-text"
    >
      {label}
      <ChevronIcon />
    </span>
  );
}

function CardSkeleton({ title }: { title: string }) {
  return (
    <article className="frame flex flex-col gap-3 p-4">
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
        {title}
      </span>
      <div className="flex flex-col gap-2">
        <div className="h-2.5 rounded-[2px] bg-text-faint/15" />
        <div className="h-2.5 w-3/4 rounded-[2px] bg-text-faint/15" />
        <div className="h-2.5 w-1/2 rounded-[2px] bg-text-faint/15" />
      </div>
    </article>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.5V6l1.6 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M1.5 7s1.7-3.5 5.5-3.5S12.5 7 12.5 7s-1.7 3.5-5.5 3.5S1.5 7 1.5 7Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="7" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M3.5 2 6.5 5 3.5 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
