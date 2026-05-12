import { useCallback, useEffect, useReducer, useState } from "react";
import DropZone from "./lib/components/DropZone";
import ScanProgress from "./lib/components/ScanProgress";
import SignatureList from "./lib/components/SignatureList";
import ErrorBanner from "./lib/components/ErrorBanner";
import RemoteStatus from "./lib/components/RemoteStatus";
import UpdaterButton from "./lib/components/UpdaterButton";
import BrandMark from "./lib/components/BrandMark";
import AppFooter from "./lib/components/AppFooter";
import HistoryPanel from "./lib/components/HistoryPanel";
import IdleDashboard from "./lib/components/IdleDashboard";
import WatcherPanel from "./lib/components/WatcherPanel";
import { cancelScan, isAppError, scanJar, subscribeWatcher } from "./lib/api";
import type { AppError, ScanResult, ScanState } from "./lib/types";
import { cn } from "./lib/cn";

type Action =
  | { type: "start"; path: string }
  | { type: "success"; result: ScanResult }
  | { type: "fail"; error: AppError; lastPath: string | null }
  | { type: "reset" };

function reducer(_state: ScanState, action: Action): ScanState {
  switch (action.type) {
    case "start": {
      const fileName = action.path.split(/[\\/]/).pop() ?? action.path;
      return { state: "scanning", fileName, path: action.path };
    }
    case "success":
      return { state: "result", result: action.result };
    case "fail":
      return { state: "error", error: action.error, lastPath: action.lastPath };
    case "reset":
      return { state: "idle" };
  }
}

export default function App() {
  const [scan, dispatch] = useReducer(
    reducer,
    { state: "idle" } as ScanState,
  );
  // While idle, the watcher and history panels can take over the main area.
  // Starting a scan from anywhere returns the user to the scan view.
  const [showingHistory, setShowingHistory] = useState(false);
  const [showingWatcher, setShowingWatcher] = useState(false);

  const startScan = useCallback(async (path: string) => {
    setShowingHistory(false);
    setShowingWatcher(false);
    dispatch({ type: "start", path });
    try {
      const result = await scanJar(path);
      dispatch({ type: "success", result });
    } catch (raw) {
      const err: AppError = isAppError(raw)
        ? raw
        : {
            kind: "network",
            message: String((raw as { message?: string })?.message ?? raw),
          };
      if (err.kind === "cancelled") {
        dispatch({ type: "reset" });
        return;
      }
      dispatch({ type: "fail", error: err, lastPath: path });
    }
  }, []);

  const reset = useCallback(() => {
    setShowingHistory(false);
    setShowingWatcher(false);
    dispatch({ type: "reset" });
  }, []);
  const retry = useCallback(() => {
    if (scan.state === "error" && scan.lastPath) {
      void startScan(scan.lastPath);
    }
  }, [scan, startScan]);
  const cancel = useCallback(() => {
    void cancelScan();
  }, []);
  const showHistory = useCallback(() => {
    setShowingWatcher(false);
    setShowingHistory(true);
  }, []);
  const hideHistory = useCallback(() => setShowingHistory(false), []);
  const showWatcher = useCallback(() => {
    setShowingHistory(false);
    setShowingWatcher(true);
  }, []);
  const hideWatcher = useCallback(() => setShowingWatcher(false), []);

  const inHistoryView = scan.state === "idle" && showingHistory;
  const inWatcherView = scan.state === "idle" && showingWatcher;

  useEffect(() => {
    return subscribeWatcher((ev) => {
      if (ev.type === "focus-review") {
        setShowingHistory(false);
        setShowingWatcher(true);
      }
    });
  }, []);

  const contextLabel = inWatcherView
    ? "Folder watcher"
    : inHistoryView
      ? "Scan history"
      : scan.state === "scanning"
        ? `Scanning ${scan.fileName}`
        : scan.state === "result"
          ? `Report · ${scan.result.fileName}`
          : scan.state === "error"
            ? "Scan failed"
            : null;

  const contextTone =
    scan.state === "scanning"
      ? "accent"
      : scan.state === "error"
        ? "critical"
        : scan.state === "result"
          ? "ok"
          : "muted";

  return (
    <>
      <TopBar
        onReset={reset}
        contextLabel={contextLabel}
        contextTone={contextTone}
        scanning={scan.state === "scanning"}
      />

      <main
        className="relative flex w-full min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-8 pt-5"
        style={{
          paddingLeft: "clamp(20px, 2.4vw, 36px)",
          paddingRight: "clamp(20px, 2.4vw, 36px)",
        }}
      >
        {scan.state === "error" && (
          <ErrorBanner
            error={scan.error}
            onRetry={retry}
            onDismiss={reset}
            canRetry={scan.lastPath !== null}
          />
        )}

        {inHistoryView && <HistoryPanel onBack={hideHistory} />}
        {inWatcherView && <WatcherPanel onBack={hideWatcher} />}

        {scan.state === "idle" && !showingHistory && !showingWatcher && (
          <IdleDashboard
            onPick={startScan}
            onShowHistory={showHistory}
            onShowWatcher={showWatcher}
          />
        )}

        {scan.state === "error" && <DropZone onPick={startScan} />}
        {scan.state === "scanning" && (
          <ScanProgress fileName={scan.fileName} onCancel={cancel} />
        )}
        {scan.state === "result" && (
          <SignatureList result={scan.result} onReset={reset} />
        )}
      </main>

      <AppFooter />
    </>
  );
}

interface TopBarProps {
  onReset: () => void;
  contextLabel: string | null;
  contextTone: "accent" | "critical" | "ok" | "muted";
  scanning: boolean;
}

function TopBar({ onReset, contextLabel, contextTone, scanning }: TopBarProps) {
  const toneClass =
    contextTone === "accent"
      ? "text-accent"
      : contextTone === "critical"
        ? "text-sev-critical"
        : contextTone === "ok"
          ? "text-status-ok"
          : "text-text-muted";

  return (
    <header className="relative flex shrink-0 items-center justify-between gap-4 border-b border-border-faint bg-bg px-5 py-2.5">
      <button
        type="button"
        onClick={onReset}
        aria-label="Return to home"
        className="group inline-flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] border-0 bg-transparent p-1 -m-1 text-left transition-opacity duration-fast ease-out hover:opacity-90"
      >
        <BrandMark />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-[-0.005em] text-text">
            JLab Desktop
          </span>
          <span className="text-[11.5px] uppercase tracking-[0.08em] text-text-dim">
            Static JAR scanner
          </span>
        </div>
      </button>

      {contextLabel && (
        <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 sm:flex">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
              contextTone === "accent" && "bg-accent animate-status-pulse",
              contextTone === "critical" && "bg-sev-critical",
              contextTone === "ok" && "bg-status-ok",
              contextTone === "muted" && "bg-text-faint",
              scanning && "animate-status-pulse",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate text-[13.5px] font-medium",
              toneClass,
            )}
            title={contextLabel}
          >
            {contextLabel}
          </span>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <UpdaterButton />
        <RemoteStatus />
      </div>
    </header>
  );
}
