import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeScanPhases } from "../api";
import type { ScanPhaseEvent, ScanPhaseId, ScanPhaseStatus } from "../types";
import { cn } from "../cn";

type LadderId = "validate" | "read" | "upload" | "server" | "parse";

interface LadderStep {
  id: LadderId;
  label: string;
  sub: string;
}

const LADDER: ReadonlyArray<LadderStep> = [
  { id: "validate", label: "Validating",     sub: "Checking the file and the 50 MB limit." },
  { id: "read",     label: "Reading archive", sub: "Loading bytes from disk." },
  { id: "upload",   label: "Uploading",       sub: "Sending the file over TLS to jlab.threat.rip." },
  { id: "server",   label: "Server scan",     sub: "Matching against the JLab signature set." },
  { id: "parse",    label: "Parsing results", sub: "Decoding the signature manifest." },
];

const LADDER_INDEX: Record<LadderId, number> = {
  validate: 0,
  read: 1,
  upload: 2,
  server: 3,
  parse: 4,
};

const TIPS = [
  "Drag and drop works anywhere in this window.",
  "Results are grouped by severity, with critical first.",
  "Each match shows the class and method that triggered it.",
  "Up to 50 MB per file. 15 scans per minute.",
];

type StepState = "queued" | "running" | "done" | "error";

interface LogEntry {
  id: number;
  phase: ScanPhaseId;
  status: ScanPhaseStatus;
  elapsedMs: number;
  detail: string | null;
}

function fmtElapsed(ms: number): { whole: string; frac: string; unit: string } {
  if (ms < 1000) {
    const v = Math.max(0, Math.round(ms));
    return { whole: String(v), frac: "", unit: "ms" };
  }
  const total = ms / 1000;
  const whole = Math.floor(total);
  const frac = String(Math.floor((total - whole) * 100)).padStart(2, "0");
  return { whole: String(whole), frac, unit: "s" };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface Props {
  fileName: string;
  onCancel: () => void;
}

export default function ScanProgress({ fileName, onCancel }: Props) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);
  const [steps, setSteps] = useState<Record<LadderId, StepState>>({
    validate: "queued",
    read: "queued",
    upload: "queued",
    server: "queued",
    parse: "queued",
  });
  const [phaseDurations, setPhaseDurations] = useState<Partial<Record<LadderId, number>>>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const phaseStartRef = useRef<Partial<Record<LadderId, number>>>({});

  useEffect(() => {
    const t0 = performance.now();
    const elapsedTimer = window.setInterval(() => {
      setElapsedMs(performance.now() - t0);
    }, 60);
    const tipTimer = window.setInterval(() => {
      setTipIndex((i) => (i + 1) % TIPS.length);
    }, 4500);
    return () => {
      window.clearInterval(elapsedTimer);
      window.clearInterval(tipTimer);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeScanPhases((event) => {
      handlePhase(event);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePhase = useCallback((event: ScanPhaseEvent) => {
    const { phase, status, elapsedMs: ev, detail } = event;
    setLog((prev) => {
      const next = prev.slice(-199);
      next.push({ id: logIdRef.current++, phase, status, elapsedMs: ev, detail });
      return next;
    });

    if (phase in LADDER_INDEX) {
      const id = phase as LadderId;
      if (status === "running") {
        phaseStartRef.current[id] = ev;
        setSteps((s) => ({ ...s, [id]: "running" }));
      } else if (status === "done") {
        const start = phaseStartRef.current[id] ?? ev;
        setPhaseDurations((d) => ({ ...d, [id]: Math.max(0, ev - start) }));
        setSteps((s) => ({ ...s, [id]: "done" }));
      } else if (status === "error") {
        setSteps((s) => ({ ...s, [id]: "error" }));
      }
    } else if (phase === "failed") {
      setSteps((s) => {
        const next = { ...s };
        for (const id of Object.keys(next) as LadderId[]) {
          if (next[id] === "running") next[id] = "error";
        }
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [log, logOpen]);

  const activeIndex = useMemo(() => {
    let lastDone = -1;
    let firstRunning = -1;
    for (const step of LADDER) {
      const i = LADDER_INDEX[step.id];
      const s = steps[step.id];
      if (s === "done") lastDone = i;
      if (s === "running" && firstRunning === -1) firstRunning = i;
    }
    if (firstRunning !== -1) return firstRunning;
    if (lastDone !== -1) return Math.min(lastDone + 1, LADDER.length - 1);
    return 0;
  }, [steps]);

  const stillWorking = elapsedMs > 6000;
  const elapsed = fmtElapsed(elapsedMs);

  function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    onCancel();
  }

  return (
    <div className="flex animate-rise-in flex-col gap-3">
      <div className="bracketed relative overflow-hidden rounded-[var(--radius-lg)] border border-border bg-bg-plate">
        <span className="bracket-bl" aria-hidden="true" />
        <span className="bracket-br" aria-hidden="true" />

        {/* Header strip with file + status badge + cancel. */}
        <div className="flex items-center justify-between gap-3 border-b border-border-faint bg-bg-plate/40 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="label-accent flex items-center gap-2">
              <span aria-hidden="true" className="block h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)] animate-pulse-soft" />
              {cancelling ? "cancelling" : "scanning"}
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-border" />
            <span
              className="min-w-0 max-w-[440px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-text-muted"
              title={fileName}
            >
              {fileName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="label">job&nbsp;//&nbsp;01</span>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="cursor-pointer rounded-[var(--radius-sm)] border border-border bg-bg-plate px-2.5 py-1 text-[12px] font-medium text-text-muted transition-[background,border-color,color,transform] duration-fast ease-out hover:border-[color:var(--color-sev-critical-edge)] hover:text-sev-critical active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 disabled:pointer-events-none"
            >
              <span className="inline-flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                {cancelling ? "Cancelling" : "Cancel"}
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(220px,260px)_1fr] gap-0 max-[820px]:grid-cols-1">
          {/* Elapsed read-out. The big number. */}
          <div className="relative flex flex-col justify-between gap-3 border-r border-border-faint bg-bg-plate/30 p-5 max-[820px]:border-r-0 max-[820px]:border-b max-[820px]:border-border-faint">
            <div className="flex flex-col gap-1.5">
              <span className="label">elapsed</span>
              <div className="tnum flex items-baseline gap-1 leading-[0.95]">
                <span className="text-[48px] font-semibold tracking-[-0.03em] text-text">
                  {elapsed.whole}
                </span>
                {elapsed.frac && (
                  <span className="text-[28px] font-medium tracking-[-0.02em] text-text-muted">
                    .{elapsed.frac}
                  </span>
                )}
                <span className="ml-1 font-mono text-[13px] uppercase tracking-[0.16em] text-text-dim">
                  {elapsed.unit}
                </span>
              </div>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-text-faint">
                {cancelling ? "cancelling" : stillWorking ? "still working" : "live"}
              </span>
            </div>

            {/* Indeterminate progress bar. Transform-only animation. */}
            <div className="relative h-[3px] overflow-hidden rounded-[2px] bg-bg-elev">
              <div
                className="absolute inset-y-0 left-0 w-full origin-left rounded-[2px] bg-accent shadow-[0_0_8px_var(--color-accent-glow)] will-change-transform animate-indeterminate"
              />
            </div>
          </div>

          {/* Phase ladder. */}
          <ol className="m-0 flex list-none flex-col p-3 pl-2">
            {LADDER.map((p, i) => {
              const state = steps[p.id];
              const done = state === "done";
              const errored = state === "error";
              const active = state === "running" || (i === activeIndex && state === "queued" && !errored);
              const dur = phaseDurations[p.id];
              return (
                <li
                  key={p.id}
                  className={cn(
                    "grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2 transition-[background] duration-fast ease-out",
                    state === "running" && "bg-accent-soft",
                    errored && "bg-sev-critical-soft",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "tnum w-[18px] text-right font-mono text-[10px] font-semibold tracking-[0.06em] transition-colors duration-base ease-out",
                        done && "text-text-muted",
                        state === "running" && "text-accent",
                        errored && "text-sev-critical",
                        state === "queued" && "text-text-faint",
                      )}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-flex h-[14px] w-[14px] items-center justify-center rounded-full transition-[background,color] duration-base ease-out",
                        done && "bg-accent-soft text-accent",
                        state === "running" && "bg-accent text-accent-ink",
                        errored && "bg-sev-critical-soft text-sev-critical",
                        state === "queued" && "bg-bg-elev text-transparent border border-border",
                      )}
                    >
                      {done ? (
                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2.5 6.5 5 9l4.5-5.5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : errored ? (
                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                          <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      ) : state === "running" ? (
                        <span className="block h-[5px] w-[5px] rounded-full bg-accent-ink" />
                      ) : (
                        <span className="block h-1 w-1 rounded-full bg-border-strong" />
                      )}
                    </span>
                  </span>

                  <div className="flex min-w-0 flex-col gap-px">
                    <span
                      className={cn(
                        "text-[14px] transition-colors duration-base ease-out",
                        done && "font-medium text-text",
                        state === "running" && "font-semibold text-text",
                        errored && "font-semibold text-text",
                        state === "queued" && "text-text-dim",
                      )}
                    >
                      {p.label}
                    </span>
                    <span
                      className={cn(
                        "text-[12.5px] leading-[1.4]",
                        active ? "text-text-muted" : "text-text-faint",
                      )}
                    >
                      {p.sub}
                    </span>
                  </div>

                  <span
                    className={cn(
                      "tnum font-mono text-[10.5px] uppercase tracking-[0.12em]",
                      done && "text-text-dim",
                      state === "running" && "text-accent",
                      errored && "text-sev-critical",
                      state === "queued" && "text-text-faint",
                    )}
                  >
                    {done
                      ? dur != null
                        ? fmtMs(dur)
                        : "done"
                      : errored
                      ? "error"
                      : state === "running"
                      ? stillWorking && p.id === "server"
                        ? "holding"
                        : "running"
                      : "queued"}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Debug log panel. Collapsed by default. */}
        <div className="border-t border-border-faint">
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-4 py-2 text-left transition-colors duration-fast ease-out hover:bg-bg-hover/40"
          >
            <span className="flex items-center gap-2">
              <span className="label">debug log</span>
              <span aria-hidden="true" className="h-3 w-px bg-border" />
              <span className="tnum font-mono text-[11px] text-text-muted">
                {log.length} {log.length === 1 ? "event" : "events"}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center text-text-dim transition-transform duration-base ease-out will-change-transform",
                logOpen && "[transform:rotate(180deg)]",
              )}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="m2.5 4.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          {logOpen && (
            <div
              ref={logEndRef}
              className="max-h-48 overflow-y-auto border-t border-border-faint bg-bg-inset/60 px-4 py-2.5 font-mono text-[11.5px] leading-[1.55]"
            >
              {log.length === 0 ? (
                <div className="text-text-faint">Waiting for the first event.</div>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {log.map((entry) => (
                    <li key={entry.id} className="flex items-baseline gap-2">
                      <span className="tnum w-[60px] shrink-0 text-text-faint">
                        {fmtMs(entry.elapsedMs).padStart(7, " ")}
                      </span>
                      <span
                        className={cn(
                          "w-[68px] shrink-0 uppercase tracking-[0.1em]",
                          entry.status === "error" || entry.phase === "failed"
                            ? "text-sev-critical"
                            : entry.phase === "cancelled"
                            ? "text-text-dim"
                            : entry.status === "running"
                            ? "text-accent"
                            : "text-text-muted",
                        )}
                      >
                        {entry.phase}
                      </span>
                      <span className="w-[58px] shrink-0 text-text-dim">
                        {entry.status}
                      </span>
                      <span className="min-w-0 flex-1 break-all text-text-muted">
                        {entry.detail ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <aside
        aria-live="polite"
        className="flex items-center gap-2.5 overflow-hidden rounded-[var(--radius)] border border-border-faint bg-bg-plate/60 px-3.5 py-2"
      >
        <span className="label-accent flex items-center gap-2">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M7 4v3.5M7 9.5v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          tip
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-border" />
        <span key={tipIndex} className="flex-1 animate-fade-in text-[12.5px] text-text-muted">
          {TIPS[tipIndex]}
        </span>
      </aside>
    </div>
  );
}
