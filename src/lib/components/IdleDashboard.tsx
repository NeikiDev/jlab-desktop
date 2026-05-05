import { useEffect, useMemo, useState } from "react";
import DropZone from "./DropZone";
import Sha256Chip from "./Sha256Chip";
import { historyCap, historyList } from "../api";
import type { HistoryEntry, Severity } from "../types";
import { cn } from "../cn";

interface Props {
  onPick: (path: string) => void;
  onShowHistory: () => void;
}

// Fallback while the IPC fetch is in flight. The real value comes from the
// Rust constant via the `history_cap` command, so the two never drift.
const HISTORY_CAP_FALLBACK = 100;

const SEV_DOT: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
  info: "bg-sev-info",
};

const SEV_TEXT: Record<Severity, string> = {
  critical: "text-sev-critical",
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-sev-low",
  info: "text-sev-info",
};

function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 45) return s <= 1 ? "now" : `${s}s ago`;
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

export default function IdleDashboard({ onPick, onShowHistory }: Props) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [cap, setCap] = useState<number>(HISTORY_CAP_FALLBACK);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    historyList()
      .then((entries) => {
        if (!cancelled) setHistory(entries);
      })
      .catch((e) => {
        console.warn("[IdleDashboard] history list failed", e);
        if (!cancelled) setHistory([]);
      });
    historyCap()
      .then((v) => {
        if (!cancelled && Number.isFinite(v) && v > 0) setCap(v);
      })
      .catch((e) => {
        console.warn("[IdleDashboard] history cap failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Newest first for the list. The backend stores oldest-first to make
  // append O(1) and cap-trim cheap; we flip it here only for the UI.
  const recent = useMemo(() => {
    if (!history) return null;
    return [...history].reverse().slice(0, 3);
  }, [history]);

  const total = history?.length ?? 0;

  return (
    <div className="flex w-full animate-rise-in flex-col gap-5">
      <DropZone onPick={onPick} />

      <div className="grid gap-4 grid-cols-2 max-[820px]:grid-cols-1">
        <Module
          label="recent scans"
          subtitle={total === 0 ? "empty" : `${total}/${cap} stored`}
          delay={60}
        >
          {recent === null ? (
            <ModuleSkeleton lines={3} />
          ) : recent.length === 0 ? (
            <EmptyRecent />
          ) : (
            <ul className="flex flex-col">
              {recent.map((e, i) => (
                <li
                  key={e.id}
                  className={cn(
                    "flex flex-col gap-0.5 px-1 py-2",
                    i > 0 && "border-t border-border-faint",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        SEV_DOT[(e.topSeverity as Severity) ?? "info"],
                      )}
                    />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px] text-text"
                      title={e.fileName}
                    >
                      {e.fileName}
                    </span>
                    <span
                      className={cn(
                        "tnum shrink-0 font-mono text-[10.5px] uppercase tracking-[0.1em]",
                        SEV_TEXT[(e.topSeverity as Severity) ?? "info"],
                      )}
                    >
                      {e.topSeverity}
                    </span>
                    <span
                      className="tnum shrink-0 font-mono text-[10.5px] text-text-faint"
                      title={e.scannedAt}
                    >
                      {formatRelative(e.scannedAt, now)}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center pl-[14px]">
                    <Sha256Chip value={e.sha256} preview={20} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={onShowHistory}
            disabled={total === 0}
            className="mt-3 flex w-full cursor-pointer items-center justify-between rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev px-3 py-2 text-[12px] font-medium text-text transition-[background,border-color,transform] duration-fast ease-out hover:border-accent hover:bg-bg-hover hover:text-accent active:translate-y-[1px] disabled:cursor-default disabled:opacity-40 disabled:hover:border-border-faint disabled:hover:bg-bg-elev disabled:hover:text-text disabled:active:translate-y-0"
          >
            <span className="font-mono uppercase tracking-[0.14em]">
              {total === 0 ? "nothing to view" : `view all (${total})`}
            </span>
            <span aria-hidden="true" className="text-[14px] leading-none">
              ›
            </span>
          </button>
        </Module>

        <Module label="folder watcher" subtitle="off" delay={120}>
          <div className="flex items-start gap-3">
            <FauxToggle off />
            <div className="flex-1">
              <p className="m-0 text-[12.5px] leading-[1.45] text-text-muted">
                Auto-scan files as they appear in a folder you choose. Opt-in,
                local only.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[var(--radius-sm)] border border-dashed border-border-faint px-3 py-2">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-text-dim">
              status
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent">
              <span
                aria-hidden="true"
                className="h-1 w-1 rounded-full bg-accent animate-status-pulse"
              />
              coming soon
            </span>
          </div>
        </Module>
      </div>
    </div>
  );
}

interface ModuleProps {
  label: string;
  subtitle?: string;
  children: React.ReactNode;
  delay?: number;
}

function Module({ label, subtitle, children, delay = 0 }: ModuleProps) {
  return (
    <section
      className="bracketed relative flex animate-rise-in flex-col rounded-[var(--radius)] border border-border-faint bg-bg-plate/80 p-4 transition-[border-color] duration-base ease-out hover:border-border"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
    >
      <span className="bracket-bl" aria-hidden="true" />
      <span className="bracket-br" aria-hidden="true" />

      <header className="mb-3 flex items-center justify-between gap-2">
        <span className="label-accent">{label}</span>
        {subtitle && (
          <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-text-faint">
            {subtitle}
          </span>
        )}
      </header>

      {children}
    </section>
  );
}

function ModuleSkeleton({ lines }: { lines: number }) {
  return (
    <ul className="flex flex-col gap-2 py-1">
      {Array.from({ length: lines }).map((_, i) => (
        <li key={i} className="flex items-center gap-2 opacity-30">
          <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
          <span className="h-2 flex-1 rounded-[2px] bg-text-faint/40" />
        </li>
      ))}
    </ul>
  );
}

function EmptyRecent() {
  return (
    <div className="flex flex-col items-start gap-1 px-1 py-2">
      <span className="font-mono text-[12px] text-text-muted">
        No scans yet.
      </span>
      <span className="font-mono text-[11px] text-text-faint">
        Drop a file to start populating this module.
      </span>
    </div>
  );
}

function FauxToggle({ off = true }: { off?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative mt-0.5 inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border transition-[background,border-color] duration-base ease-out",
        off
          ? "border-border-faint bg-bg-inset"
          : "border-accent bg-accent-soft",
      )}
    >
      <span
        className={cn(
          "absolute h-[12px] w-[12px] rounded-full bg-text-faint transition-[transform,background] duration-base ease-out",
          off ? "left-[2px]" : "left-[16px] bg-accent",
        )}
      />
    </span>
  );
}
