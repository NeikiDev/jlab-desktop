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
  too_large: "size limit",
  rate_limited: "rate limited",
  server: "server error",
  network: "network error",
  io: "io error",
  invalid_response: "bad response",
  unsupported_file: "unsupported file",
  no_jar_in_archive: "no jar found",
  invalid_archive: "bad archive",
  cancelled: "cancelled",
  history_io: "history error",
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
      /* clipboard may be unavailable; ignore */
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
      {/* Left severity rail. */}
      <span aria-hidden="true" className="block w-[3px] shrink-0 bg-sev-critical" />

      <div className="flex flex-1 items-center gap-3 px-4 py-3">
        <span aria-hidden="true" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-sev-critical-edge)] bg-bg-plate/60 text-sev-critical">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.6 14.5 13H1.5L8 1.6Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M8 6v3M8 11h.01"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-sev-critical">
              {label}
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-[color:var(--color-sev-critical-edge)]" />
            <span className="text-[13px] font-medium text-text">
              {appErrorToUserText(error)}
            </span>
          </div>

          {error.kind === "rate_limited" && countdown > 0 && (
            <div className="tnum mt-1 font-mono text-[11.5px] text-text-muted">
              retry available in {countdown}s
            </div>
          )}

          {showSupport && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[12px] text-text-muted">
              {code && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">
                    code
                  </span>
                  <button
                    type="button"
                    title="Click to copy"
                    onClick={copyCode}
                    className="cursor-pointer select-all rounded-[3px] border border-border-faint bg-bg-plate px-1.5 py-0.5 font-mono text-[11px] text-text transition-colors duration-fast ease-out hover:border-border"
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
                  className="cursor-pointer border-0 bg-transparent p-0 font-inherit normal-case tracking-normal text-accent underline-offset-[2px] hover:text-accent-bright hover:underline"
                >
                  our Discord
                </button>
                {" "}and attach the{" "}
                <button
                  type="button"
                  onClick={openLogs}
                  className="cursor-pointer border-0 bg-transparent p-0 font-inherit normal-case tracking-normal text-accent underline-offset-[2px] hover:text-accent-bright hover:underline"
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
              className="cursor-pointer rounded-[var(--radius-sm)] border border-border bg-bg-plate px-3.5 py-1.5 text-[12.5px] font-medium text-text transition-[background,border-color,transform] duration-fast ease-out hover:bg-bg-hover hover:border-border-strong active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="cursor-pointer rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1.5 text-text-muted transition-[background,color] duration-fast ease-out hover:bg-bg-hover hover:text-text"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path
                d="m3 3 7 7M10 3l-7 7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
