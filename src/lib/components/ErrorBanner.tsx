import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "../types";
import {
  appErrorToUserText,
  appErrorCode,
  appErrorWantsSupport,
  DISCORD_URL,
  openLogDir,
} from "../api";

interface Props {
  error: AppError;
  onRetry: () => void;
  onDismiss: () => void;
  canRetry: boolean;
}

const ERROR_LABEL: Record<AppError["kind"], string> = {
  too_large: "Size limit",
  rate_limited: "Rate limited",
  server: "Server error",
  network: "Network error",
  io: "IO error",
  invalid_response: "Bad response",
  unsupported_file: "Unsupported file",
  no_jar_in_archive: "No jar found",
  invalid_archive: "Bad archive",
  cancelled: "Cancelled",
  history_io: "History error",
  watcher_io: "Watcher error",
  invalid_watch_path: "Invalid folder",
  trash_failed: "Trash failed",
  rename_failed: "Rename failed",
  watcher_disabled: "Watcher off",
  notification_denied: "Notifications off",
};

export default function ErrorBanner({ error, onRetry, onDismiss, canRetry }: Props) {
  const code = appErrorCode(error);
  const showSupport = appErrorWantsSupport(error);
  const label = ERROR_LABEL[error.kind];

  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (error.kind !== "rate_limited") {
      setCountdown(0);
      return;
    }
    setCountdown(error.retry_after_seconds);
    const id = window.setInterval(() => {
      setCountdown((c) => {
        const next = Math.max(0, c - 1);
        if (next === 0) window.clearInterval(id);
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [error]);

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* ignore */
    }
  }

  async function openDiscord() {
    try {
      await invoke("open_url", { url: DISCORD_URL });
    } catch (e) {
      console.error("[ErrorBanner] failed to open Discord url", e);
    }
  }

  async function openLogs() {
    try {
      await openLogDir();
    } catch (e) {
      console.error("[ErrorBanner] failed to open log folder", e);
    }
  }

  const retryDisabled = error.kind === "rate_limited" && countdown > 0;

  return (
    <div className="relative flex animate-rise-in items-stretch overflow-hidden rounded-[var(--radius)] border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft text-text">
      <span aria-hidden="true" className="block w-[3px] shrink-0 bg-sev-critical" />

      <div className="flex flex-1 items-start gap-3.5 px-4 py-3.5">
        <span
          aria-hidden="true"
          className="mt-[2px] inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-sev-critical-edge)] bg-bg-plate/60 text-sev-critical"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.6 14.5 13H1.5L8 1.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6v3M8 11h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-sev-critical">
              {label}
            </span>
            <span aria-hidden="true" className="text-text-faint">&middot;</span>
            <span className="text-[13.5px] text-text">
              {appErrorToUserText(error)}
            </span>
          </div>

          {error.kind === "rate_limited" && countdown > 0 && (
            <div className="tnum mt-1 text-[12px] text-text-muted">
              Retry available in {countdown}s
            </div>
          )}

          {showSupport && (
            <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[12.5px] text-text-muted">
              {code && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[11px] text-text-dim">Code</span>
                  <button
                    type="button"
                    title="Click to copy"
                    onClick={copyCode}
                    className="cursor-pointer select-all rounded-[3px] border border-border-faint bg-bg-plate px-2 py-0.5 font-mono text-[11px] text-text transition-colors duration-fast ease-out hover:border-border"
                  >
                    {code}
                  </button>
                </span>
              )}
              <span className="text-text-muted">
                Need help? Share this code in{" "}
                <button
                  type="button"
                  onClick={openDiscord}
                  className="cursor-pointer border-0 bg-transparent p-0 text-accent underline-offset-[2px] hover:text-accent-bright hover:underline"
                >
                  our Discord
                </button>
                {" "}and attach the{" "}
                <button
                  type="button"
                  onClick={openLogs}
                  className="cursor-pointer border-0 bg-transparent p-0 text-accent underline-offset-[2px] hover:text-accent-bright hover:underline"
                >
                  log folder
                </button>
                .
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              className="cursor-pointer rounded-[var(--radius-sm)] border border-border bg-bg-plate/80 px-3.5 py-1.5 text-[12.5px] font-medium text-text transition-[background,border-color,transform] duration-fast ease-out hover:bg-bg-elev hover:border-border-strong active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="cursor-pointer rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1.5 text-text-muted transition-[background,color] duration-fast ease-out hover:bg-bg-elev hover:text-text"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path d="m3 3 7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
