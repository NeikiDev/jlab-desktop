import { useEffect, useState } from "react";
import type { WatcherRuntimeState } from "../types";
import { cn } from "../cn";

interface Props {
  runtime: WatcherRuntimeState;
  recent: ReviewItem[];
}

export interface ReviewItem {
  fileName: string;
  path: string;
  topSeverity: string;
  signatureCount: number;
  flagged: boolean;
  action: "quarantined" | "trashed" | null;
  reappeared?: boolean;
  priorAction?: "quarantined" | "trashed" | null;
  at: number;
}

const SEV_TEXT: Record<string, string> = {
  critical: "text-sev-critical",
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-sev-low",
  info: "text-sev-info",
};

const SEV_DOT: Record<string, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
  info: "bg-sev-info",
};

export default function WatcherStatusCard({ runtime, recent }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (runtime.runState !== "scanning" || runtime.currentStartedMs === null)
      return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [runtime.runState, runtime.currentStartedMs]);

  const elapsedMs =
    runtime.runState === "scanning" && runtime.currentStartedMs
      ? Math.max(0, now - runtime.currentStartedMs)
      : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  const hasCurrentFile =
    runtime.runState === "scanning" && !!runtime.currentFile;
  const isWaiting =
    !hasCurrentFile &&
    (runtime.queueDepth > 0 || runtime.runState === "scanning");

  const stateLabel = hasCurrentFile
    ? "Scanning"
    : isWaiting
      ? runtime.queueDepth > 0
        ? `Queued, ${runtime.queueDepth} waiting…`
        : "Starting next scan…"
      : runtime.runState === "idle"
        ? "Watching, no scans in progress"
        : runtime.runState === "paused"
          ? "Paused"
          : "Watcher is off";

  const stateDotClass = hasCurrentFile
    ? "bg-status-ok animate-status-pulse"
    : isWaiting
      ? "bg-sev-medium animate-status-pulse"
      : runtime.runState === "idle"
        ? "bg-status-ok animate-status-pulse"
        : runtime.runState === "paused"
          ? "bg-sev-medium"
          : "bg-text-faint";

  const isIdleEmpty =
    !hasCurrentFile && !isWaiting && recent.length === 0;

  return (
    <section
      className={cn(
        "frame flex flex-col gap-3 px-4",
        isIdleEmpty ? "py-2.5" : "py-3.5",
      )}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
            Current scan
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stateDotClass)}
            />
            <span className="text-[13.5px] text-text-muted">{stateLabel}</span>
          </span>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold uppercase tracking-[0.08em]",
            runtime.queueDepth > 0
              ? "border-sev-medium-edge text-sev-medium"
              : "border-border-faint text-text-faint",
          )}
        >
          Queue {runtime.queueDepth}
        </span>
      </header>

      {hasCurrentFile && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span
              className="min-w-0 max-w-full flex-1 truncate font-mono text-[13.5px] text-text"
              title={runtime.currentFile!}
            >
              {runtime.currentFile}
            </span>
            <span className="tnum shrink-0 text-[13px] text-text-muted">
              {elapsedSec}s
            </span>
          </div>
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-bg-inset">
            <span
              aria-hidden="true"
              className="absolute inset-0 origin-left animate-indeterminate bg-status-ok"
            />
          </div>
        </div>
      )}

      {!hasCurrentFile && isWaiting && (
        <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
          <span
            aria-hidden="true"
            className="inline-block h-1 w-1 shrink-0 rounded-full bg-sev-medium animate-pulse-soft"
          />
          {runtime.queueDepth > 0
            ? "Waiting on the next file. The watcher caps uploads at 12 per minute."
            : "Preparing the next scan."}
        </div>
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border-faint pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
              Recent hits
            </span>
            <span className="text-[11.5px] uppercase tracking-[0.08em] text-text-faint">
              {recent.length} {recent.length === 1 ? "hit" : "hits"}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {recent.slice(0, 8).map((r) => {
              const reappearedLabel = r.reappeared
                ? r.priorAction === "trashed"
                  ? "previously deleted"
                  : "previously quarantined"
                : null;
              const titleSuffix = reappearedLabel
                ? ` (${reappearedLabel}, moved back)`
                : r.action
                  ? ` (${r.action})`
                  : "";
              return (
                <li
                  key={`${r.path}-${r.at}`}
                  title={`${r.fileName} - ${r.topSeverity} - ${r.signatureCount} signature${r.signatureCount === 1 ? "" : "s"}${titleSuffix}`}
                  className={cn(
                    "inline-flex max-w-[280px] items-center gap-2 rounded-full border border-border-faint bg-bg-elev/40 px-2.5 py-0.5 text-[12.5px] text-text",
                    r.reappeared &&
                      "border-sev-medium-edge bg-sev-medium-soft text-sev-medium",
                    !r.reappeared &&
                      r.action === "trashed" &&
                      "border-sev-critical-edge bg-sev-critical-soft text-sev-critical",
                    !r.reappeared &&
                      r.action === "quarantined" &&
                      "border-sev-high-edge bg-sev-high-soft text-sev-high",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      SEV_DOT[r.topSeverity] ?? "bg-text-faint",
                    )}
                  />
                  <span className="min-w-0 max-w-[180px] truncate font-mono text-[12px]">
                    {r.fileName}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-medium capitalize",
                      r.reappeared
                        ? "text-sev-medium"
                        : SEV_TEXT[r.topSeverity] ?? "text-text-faint",
                    )}
                  >
                    {r.reappeared ? "Moved back" : r.topSeverity}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
