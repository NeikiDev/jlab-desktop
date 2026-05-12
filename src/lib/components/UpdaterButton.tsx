import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, openUrl, type UpdateInfo } from "../api";
import { cn } from "../cn";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "error"; message: string };

const SILENT_FIRST_CHECK_DELAY_MS = 1500;
const DISMISS_KEY = "jlab.updateDismissed";

function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissedVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* ignore */
  }
}

export default function UpdaterButton() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cancelledRef = useRef(false);

  const runCheck = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      if (cancelledRef.current) return;
      if (info.available && info.latestVersion !== readDismissedVersion()) {
        setPhase({ kind: "available", info });
      } else {
        setPhase({ kind: "idle" });
      }
    } catch (e) {
      if (cancelledRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    const id = window.setTimeout(() => {
      void runCheck();
    }, SILENT_FIRST_CHECK_DELAY_MS);
    return () => {
      cancelledRef.current = true;
      window.clearTimeout(id);
    };
  }, [runCheck]);

  if (phase.kind === "idle" || phase.kind === "checking") return null;

  if (phase.kind === "available") {
    const label = phase.info.latestVersion
      ? `Update to ${phase.info.latestVersion}`
      : "Update available";
    const dismiss = () => {
      if (phase.info.latestVersion) {
        writeDismissedVersion(phase.info.latestVersion);
      }
      setPhase({ kind: "idle" });
    };
    return (
      <span className="inline-flex items-center gap-px overflow-hidden rounded-[var(--radius-sm)] bg-accent text-accent-ink">
        <button
          type="button"
          onClick={() => void openUrl(phase.info.releaseUrl)}
          title={`Open ${phase.info.releaseUrl}`}
          className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-2.5 py-1.5 text-[12px] font-semibold transition-[background] duration-fast ease-out hover:bg-accent-bright"
        >
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-accent-ink/80" />
          {label}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss update notice"
          title="Hide until the next release"
          className="inline-flex h-full cursor-pointer items-center justify-center border-0 border-l border-accent-ink/20 bg-transparent px-1.5 py-1.5 text-accent-ink/80 transition-[background,color] duration-fast ease-out hover:bg-accent-bright hover:text-accent-ink"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void runCheck()}
      title={phase.message}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-2.5 py-1 text-[12px] font-medium text-text-muted transition-[border-color] duration-fast ease-out hover:border-accent",
      )}
    >
      Update check failed. Retry
    </button>
  );
}
