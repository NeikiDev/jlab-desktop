import { useCallback, useEffect, useMemo, useState } from "react";
import { historyClear, historyDelete, historyList, isAppError } from "../api";
import type { AppError, HistoryEntry, Severity } from "../types";
import SeverityBadge from "./SeverityBadge";
import Sha256Chip from "./Sha256Chip";
import { cn } from "../cn";

interface Props {
  onBack: () => void;
}

const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return s <= 1 ? "just now" : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function HistoryPanel({ onBack }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  // Used to compute relative timestamps. We refresh it on mount and once per
  // minute while the panel is open so "5m ago" stays honest.
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      const list = await historyList();
      setEntries(list);
      setError(null);
    } catch (e) {
      const err: AppError | null = isAppError(e) ? e : null;
      setError(err ? `${err.kind}: ${("message" in err && err.message) || ""}` : String(e));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // The Rust side appends in insertion order (oldest first, newest last). For
  // the UI we want newest first, but we don't want to mutate the list we got.
  const sorted = useMemo(() => {
    if (!entries) return null;
    return [...entries].reverse();
  }, [entries]);

  async function onDelete(id: string) {
    try {
      await historyDelete(id);
      await reload();
    } catch (e) {
      console.error("[HistoryPanel] delete failed", e);
    }
  }

  async function onClear() {
    try {
      await historyClear();
      setConfirmingClear(false);
      await reload();
    } catch (e) {
      console.error("[HistoryPanel] clear failed", e);
    }
  }

  return (
    <div className="flex animate-rise-in flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-plate px-3 py-1.5 text-[13px] text-text transition-[background,border-color,transform] duration-fast ease-out hover:bg-bg-hover hover:border-border-strong active:translate-y-[1px]"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <path
                d="M8 3 4 6.5 8 10"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back
          </button>
          <div className="flex flex-col">
            <h2 className="m-0 text-[18px] font-semibold tracking-[-0.01em] text-text">
              Recent scans
            </h2>
            <p className="m-0 text-[12.5px] text-text-muted">
              Stored locally on this device. No file contents are kept.
            </p>
          </div>
        </div>

        {sorted && sorted.length > 0 && (
          <div className="flex items-center gap-2">
            {confirmingClear ? (
              <>
                <span className="text-[12.5px] text-text-muted">
                  Clear all entries?
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmingClear(false)}
                  className="cursor-pointer rounded-[var(--radius-sm)] border border-border bg-bg-plate px-3 py-1.5 text-[12.5px] text-text-muted hover:bg-bg-hover hover:border-border-strong"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="cursor-pointer rounded-[var(--radius-sm)] border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-3 py-1.5 text-[12.5px] font-medium text-sev-critical hover:brightness-110"
                >
                  Confirm clear
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingClear(true)}
                className="cursor-pointer rounded-[var(--radius-sm)] border border-border bg-bg-plate px-3 py-1.5 text-[12.5px] text-text-muted hover:bg-bg-hover hover:text-text hover:border-border-strong"
              >
                Clear history
              </button>
            )}
          </div>
        )}
      </header>

      {error && (
        <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-3 py-2 text-[12.5px] text-sev-critical">
          {error}
        </div>
      )}

      {sorted === null ? (
        <div className="rounded-[var(--radius)] border border-border-faint bg-bg-plate p-8 text-center text-[13px] text-text-muted">
          Loading…
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-border bg-bg-plate p-12 text-center">
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border-strong text-text-muted"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 4v4l2.5 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </span>
          <h3 className="m-0 text-[15px] font-semibold text-text">No scans yet</h3>
          <p className="m-0 max-w-[360px] text-[13px] text-text-muted">
            Run a scan from the home screen and it will show up here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              now={now}
              onDelete={() => onDelete(entry.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps {
  entry: HistoryEntry;
  now: number;
  onDelete: () => void;
}

function HistoryRow({ entry, now, onDelete }: RowProps) {
  const presentSeverities = useMemo(() => {
    return ORDER.filter((s) => entry.severityCounts[s] > 0);
  }, [entry.severityCounts]);

  return (
    <li
      className="flex items-center gap-4 rounded-[var(--radius)] border border-border-faint bg-bg-plate px-4 py-3 transition-[border-color] duration-fast ease-out hover:border-border"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 64px" }}
    >
      <div className="min-w-0 flex-1">
        <div
          className="break-all font-mono text-[13.5px] font-medium text-text"
          title={entry.fileName}
        >
          {entry.fileName}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-muted">
          <span className="tnum" title={formatAbsolute(entry.scannedAt)}>
            {formatRelative(entry.scannedAt, now)}
          </span>
          <span aria-hidden="true" className="text-text-faint">·</span>
          <span className="tnum">{formatBytes(entry.fileSizeBytes)}</span>
          <span aria-hidden="true" className="text-text-faint">·</span>
          <span className="tnum">
            {entry.signatureCount} signature{entry.signatureCount === 1 ? "" : "s"}
          </span>
          {entry.sha256 && (
            <>
              <span aria-hidden="true" className="text-text-faint">·</span>
              <Sha256Chip value={entry.sha256} preview={24} />
            </>
          )}
        </div>
      </div>

      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {presentSeverities.length === 0 ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-status-ok">
            clean
          </span>
        ) : (
          presentSeverities.map((sev) => (
            <span key={sev} className="inline-flex items-center gap-1">
              <SeverityBadge severity={sev} />
              <span className={cn("tnum font-mono text-[11px]", "text-text-muted")}>
                {entry.severityCounts[sev]}
              </span>
            </span>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete entry for ${entry.fileName}`}
        className="cursor-pointer rounded-[var(--radius-sm)] border border-transparent bg-transparent p-1.5 text-text-muted transition-[background,color,border-color] duration-fast ease-out hover:bg-bg-hover hover:text-sev-critical hover:border-[color:var(--color-sev-critical-edge)]"
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
    </li>
  );
}
