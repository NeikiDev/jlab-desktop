import type { StatusInfo } from "../api";
import { cn } from "../cn";

export type RemoteStatusPhase = "checking" | "online" | "offline";

const DOT_COLOR: Record<RemoteStatusPhase, string> = {
  checking: "bg-text-dim",
  online:   "bg-status-ok",
  offline:  "bg-sev-critical",
};

const LABEL: Record<RemoteStatusPhase, string> = {
  checking: "Checking",
  online: "Online",
  offline: "Offline",
};

interface Props {
  phase: RemoteStatusPhase;
  info: StatusInfo | null;
  lastChecked: Date | null;
  onRecheck: () => void;
}

export default function RemoteStatus({ phase, info, lastChecked, onRecheck }: Props) {
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
      onClick={onRecheck}
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
