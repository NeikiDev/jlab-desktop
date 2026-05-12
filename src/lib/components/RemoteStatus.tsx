import { useEffect, useRef, useState } from "react";
import { checkStatus, type StatusInfo } from "../api";
import { cn } from "../cn";

type Phase = "checking" | "online" | "offline";

const REFRESH_MS = 60_000;

const DOT_COLOR: Record<Phase, string> = {
  checking: "bg-text-dim",
  online:   "bg-status-ok",
  offline:  "bg-sev-critical",
};

const LABEL: Record<Phase, string> = {
  checking: "Checking",
  online: "Online",
  offline: "Offline",
};

export default function RemoteStatus() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const inFlight = useRef(false);
  const hasResult = useRef(false);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!hasResult.current) setPhase("checking");
    try {
      const result = await checkStatus();
      setInfo(result);
      setPhase(result.ok ? "online" : "offline");
      setLastChecked(new Date());
    } catch {
      setInfo({ ok: false, status: null, latencyMs: 0, version: null, error: "ipc error" });
      setPhase("offline");
      setLastChecked(new Date());
    } finally {
      hasResult.current = true;
      inFlight.current = false;
    }
  }

  useEffect(() => {
    let intervalId: number | null = null;

    const startInterval = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void run();
      }, REFRESH_MS);
    };

    const stopInterval = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    if (document.visibilityState !== "hidden") {
      void run();
      startInterval();
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopInterval();
      } else {
        void run();
        startInterval();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopInterval();
    };
  }, []);

  let tooltip = "Checking jlab.threat.rip…";
  if (info) {
    const parts: string[] = [];
    parts.push(info.ok ? "API reachable" : "API unreachable");
    if (info.status !== null) parts.push(`HTTP ${info.status}`);
    if (info.latencyMs) parts.push(`${info.latencyMs}ms`);
    if (info.version) parts.push(`build ${info.version}`);
    if (info.error) parts.push(info.error);
    if (lastChecked) parts.push(`checked ${lastChecked.toTimeString().slice(0, 5)}`);
    tooltip = parts.join(" · ");
  }

  return (
    <button
      type="button"
      onClick={run}
      title={tooltip}
      aria-label={`Remote status: ${LABEL[phase]}. Click to recheck.`}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border-faint bg-bg-elev/60 px-2.5 py-1 transition-[border-color,background] duration-fast ease-out hover:border-border hover:bg-bg-elev"
    >
      <span
        className={cn(
          "block h-[7px] w-[7px] shrink-0 rounded-full",
          DOT_COLOR[phase],
          phase === "checking" && "animate-status-pulse",
          phase === "online" && "shadow-[0_0_0_3px_rgba(52,211,153,0.16)]",
          phase === "offline" && "shadow-[0_0_0_3px_var(--color-sev-critical-soft)]",
        )}
      />
      <span className="text-[11.5px] font-medium text-text-muted">
        {LABEL[phase]}
      </span>
    </button>
  );
}
