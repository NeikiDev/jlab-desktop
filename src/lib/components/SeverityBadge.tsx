import type { Severity } from "../types";

const TONE: Record<Severity, { bg: string; fg: string; ring: string }> = {
  critical: {
    bg: "bg-sev-critical-soft",
    fg: "text-sev-critical",
    ring: "ring-1 ring-inset ring-[color:var(--color-sev-critical-edge)]",
  },
  high: {
    bg: "bg-sev-high-soft",
    fg: "text-sev-high",
    ring: "ring-1 ring-inset ring-[color:var(--color-sev-high-edge)]",
  },
  medium: {
    bg: "bg-sev-medium-soft",
    fg: "text-sev-medium",
    ring: "ring-1 ring-inset ring-[color:var(--color-sev-medium-edge)]",
  },
  low: {
    bg: "bg-sev-low-soft",
    fg: "text-sev-low",
    ring: "ring-1 ring-inset ring-[color:var(--color-sev-low-edge)]",
  },
  info: {
    bg: "bg-sev-info-soft",
    fg: "text-sev-info",
    ring: "ring-1 ring-inset ring-[color:var(--color-sev-info-edge)]",
  },
};

interface Props {
  severity: Severity;
}

export default function SeverityBadge({ severity }: Props) {
  const t = TONE[severity];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[11px] font-semibold capitalize leading-none ${t.bg} ${t.fg} ${t.ring}`}
    >
      <span aria-hidden="true" className="block h-[5px] w-[5px] rounded-full bg-current" />
      {severity}
    </span>
  );
}
