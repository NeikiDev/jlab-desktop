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
  { id: "upload",   label: "Uploading",       sub: "Sending the file over TLS." },
  { id: "server",   label: "Server scan",     sub: "Matching against the JLab signature set." },
  { id: "parse",    label: "Parsing results", sub: "Decoding the signature manifest." },
];

const LADDER_INDEX: Record<LadderId, number> = {
  validate: 0, read: 1, upload: 2, server: 3, parse: 4,
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

  const doneCount = useMemo(
    () => (Object.values(steps) as StepState[]).filter((s) => s === "done").length,
    [steps],
  );
  const progressPct = Math.round((doneCount / LADDER.length) * 100);

  function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    onCancel();
  }

  return (
    <div className="flex animate-rise-in flex-col gap-4">
      <section className="surface overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-border-faint px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-semibold text-text">
                {cancelling ? "Cancelling..." : "Scanning"}
              </span>
              <span
                className="min-w-0 max-w-[460px] truncate font-mono text-[11.5px] text-text-muted"
                title={fileName}
              >
                {fileName}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-3 py-1.5 text-[12px] font-medium text-text-muted transition-[background,border-color,color,transform] duration-fast ease-out hover:border-[color:var(--color-sev-critical-edge)] hover:text-sev-critical active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1.5">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {cancelling ? "Cancelling" : "Cancel"}
            </span>
          </button>
        </header>

        <div className="grid grid-cols-[260px_1fr] max-[820px]:grid-cols-1">
          <div className="flex flex-col gap-4 border-r border-border-faint p-5 max-[820px]:border-r-0 max-[820px]:border-b">
            <div className="flex flex-col gap-1.5">
              <span className="caption">Elapsed</span>
              <div className="tnum flex items-baseline gap-1 leading-[0.95]">
                <span className="text-[52px] font-semibold tracking-[-0.04em] text-text">
                  {elapsed.whole}
                </span>
                {elapsed.frac && (
                  <span className="text-[28px] font-medium tracking-[-0.02em] text-text-muted">
                    .{elapsed.frac}
                  </span>
                )}
                <span className="ml-1 text-[14px] font-medium text-text-dim">
                  {elapsed.unit}
                </span>
              </div>
              <span className="text-[12px] text-text-dim">
                {cancelling ? "Cancelling" : stillWorking ? "Still working" : "Live"}
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 text-[12px] text-text-dim">
                <span>Progress</span>
                <span className="tnum text-text-muted">{progressPct}%</span>
              </div>
              <div className="relative h-1.5 overflow-hidden rounded-full bg-bg-inset">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-base ease-out"
                  style={{ width: `${progressPct}%` }}
                />
                {doneCount < LADDER.length && (
                  <div
                    className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-accent/60 animate-indeterminate"
                  />
                )}
              </div>
            </div>
          </div>

          <ol className="m-0 flex list-none flex-col gap-0.5 p-3">
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
                    "grid grid-cols-[24px_1fr_auto] items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2 transition-[background] duration-fast ease-out",
                    state === "running" && "bg-accent-soft",
                    errored && "bg-sev-critical-soft",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded-full transition-[background,color] duration-base ease-out",
                      done && "bg-accent-soft text-accent",
                      state === "running" && "bg-accent text-accent-ink",
                      errored && "bg-sev-critical-soft text-sev-critical",
                      state === "queued" && "border border-border-faint bg-bg-inset text-transparent",
                    )}
                  >
                    {done ? (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2.5 6.5 5 9l4.5-5.5"
                          stroke="currentColor"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : errored ? (
                      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                        <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    ) : state === "running" ? (
                      <span className="block h-1.5 w-1.5 rounded-full bg-accent-ink" />
                    ) : (
                      <span className="block h-1 w-1 rounded-full bg-border-strong" />
                    )}
                  </span>

                  <div className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "text-[13.5px] transition-colors duration-base ease-out",
                        done && "text-text",
                        state === "running" && "font-semibold text-text",
                        errored && "font-semibold text-text",
                        state === "queued" && "text-text-dim",
                      )}
                    >
                      {p.label}
                    </span>
                    <span
                      className={cn(
                        "text-[12px] leading-[1.4]",
                        active ? "text-text-muted" : "text-text-dim",
                      )}
                    >
                      {p.sub}
                    </span>
                  </div>

                  <span
                    className={cn(
                      "tnum text-[11.5px]",
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

        <div className="border-t border-border-faint">
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            className="flex w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent px-5 py-2 text-left transition-colors duration-fast ease-out hover:bg-bg-elev/40"
          >
            <span className="flex items-center gap-2 text-[12px] text-text-muted">
              <span>Debug log</span>
              <span aria-hidden="true" className="text-text-faint">&middot;</span>
              <span className="tnum">{log.length} {log.length === 1 ? "event" : "events"}</span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center text-text-dim transition-transform duration-base ease-out",
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
              className="max-h-48 overflow-y-auto border-t border-border-faint bg-bg-inset/60 px-5 py-3 font-mono text-[11.5px] leading-[1.6]"
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
                          "w-[64px] shrink-0",
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
                      <span className="w-[56px] shrink-0 text-text-dim">
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
      </section>

      <aside
        aria-live="polite"
        className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border-faint bg-bg-plate/60 px-4 py-2.5"
      >
        <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent">
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
            <path d="M7 4v3.5M7 9.5v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-[12px] font-medium text-text-dim">Tip</span>
        <span aria-hidden="true" className="text-text-faint">&middot;</span>
        <span key={tipIndex} className="flex-1 animate-fade-in text-[12.5px] text-text-muted">
          {TIPS[tipIndex]}
        </span>
      </aside>
    </div>
  );
}
