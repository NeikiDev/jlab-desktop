import { useCallback, useReducer, useState } from "react";
import DropZone from "./lib/components/DropZone";
import ScanProgress from "./lib/components/ScanProgress";
import SignatureList from "./lib/components/SignatureList";
import ErrorBanner from "./lib/components/ErrorBanner";
import RemoteStatus from "./lib/components/RemoteStatus";
import UpdaterButton from "./lib/components/UpdaterButton";
import BrandMark from "./lib/components/BrandMark";
import StateCrumb from "./lib/components/StateCrumb";
import AppFooter from "./lib/components/AppFooter";
import HistoryPanel from "./lib/components/HistoryPanel";
import IdleDashboard from "./lib/components/IdleDashboard";
import { cancelScan, isAppError, scanJar } from "./lib/api";
import type { AppError, ScanResult, ScanState } from "./lib/types";

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
  // Orthogonal to scan state: the history panel only takes over while idle.
  // Starting a scan from anywhere implicitly returns the user to the scan
  // view by leaving the idle state.
  const [showingHistory, setShowingHistory] = useState(false);

  const startScan = useCallback(async (path: string) => {
    setShowingHistory(false);
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
  const showHistory = useCallback(() => setShowingHistory(true), []);
  const hideHistory = useCallback(() => setShowingHistory(false), []);
  const inHistoryView = scan.state === "idle" && showingHistory;

  return (
    <>
      <header className="relative flex shrink-0 items-center justify-between gap-4 border-b border-border-faint bg-bg-plate/80 px-5 py-2.5 backdrop-blur-[6px]">
        <button
          type="button"
          onClick={reset}
          aria-label="Return to home"
          className="group inline-flex cursor-pointer items-center gap-2.5 rounded-sm border-0 bg-transparent p-1 -m-1 text-left transition-opacity duration-fast ease-out hover:opacity-95"
        >
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-[0.02em] text-text leading-none">
            JLAB&nbsp;-&nbsp;Desktop
          </span>
        </button>
        <StateCrumb scan={scan} />
        <div className="flex items-center gap-2">
          <UpdaterButton />
          <RemoteStatus />
        </div>
      </header>

      <main
        className="relative flex w-full min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-7 pt-5"
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

        {scan.state === "idle" && !showingHistory && (
          <IdleDashboard onPick={startScan} onShowHistory={showHistory} />
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
