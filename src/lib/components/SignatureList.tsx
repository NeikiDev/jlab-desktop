import { useMemo } from "react";
import type { ScanResult, Severity, Signature } from "../types";
import SignatureCard from "./SignatureCard";
import LazyMount from "./LazyMount";
import FamilyAlert from "./FamilyAlert";
import SignatureDisclaimer from "./SignatureDisclaimer";
import ThirdPartyIntel from "./ThirdPartyIntel";
import Sha256Chip from "./Sha256Chip";
import { cn } from "../cn";

const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEV_TEXT: Record<Severity, string> = {
  critical: "text-sev-critical",
  high:     "text-sev-high",
  medium:   "text-sev-medium",
  low:      "text-sev-low",
  info:     "text-sev-info",
};

const SEV_BAR: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high:     "bg-sev-high",
  medium:   "bg-sev-medium",
  low:      "bg-sev-low",
  info:     "bg-sev-info",
};

const SEV_BAR_SOFT: Record<Severity, string> = {
  critical: "bg-sev-critical-soft",
  high:     "bg-sev-high-soft",
  medium:   "bg-sev-medium-soft",
  low:      "bg-sev-low-soft",
  info:     "bg-sev-info-soft",
};

const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high:     "High",
  medium:   "Medium",
  low:      "Low",
  info:     "Info",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface Props {
  result: ScanResult;
  onReset: () => void;
}

export default function SignatureList({ result, onReset }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<Severity, Signature[]>();
    for (const sev of ORDER) map.set(sev, []);
    for (const sig of result.signatures) {
      const sev = (ORDER.includes(sig.severity) ? sig.severity : "info") as Severity;
      map.get(sev)!.push(sig);
    }
    return map;
  }, [result.signatures]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = {
      critical: 0, high: 0, medium: 0, low: 0, info: 0,
    };
    for (const s of result.signatures) {
      if (ORDER.includes(s.severity)) c[s.severity]++;
    }
    return c;
  }, [result.signatures]);

  const maxCount = useMemo(() => {
    let m = 0;
    for (const sev of ORDER) if (counts[sev] > m) m = counts[sev];
    return m;
  }, [counts]);

  const stats = useMemo(() => {
    let totalHits = 0;
    const kinds = new Set<string>();
    const archives = new Set<string>();
    for (const s of result.signatures) {
      totalHits += s.count;
      if (s.kind) kinds.add(s.kind);
      for (const m of s.matches) {
        if (m.path) {
          const idx = m.path.indexOf("!/");
          archives.add(idx === -1 ? m.path : m.path.slice(0, idx));
        }
      }
    }
    let topSeverity: Severity | null = null;
    for (const sev of ORDER) {
      if (counts[sev] > 0) { topSeverity = sev; break; }
    }
    return {
      totalHits,
      uniqueKinds: kinds.size,
      uniqueArchives: archives.size,
      topSeverity,
    };
  }, [result.signatures, counts]);

  return (
    <div className="flex animate-rise-in flex-col gap-4">
      {result.threatIntel && <ThirdPartyIntel intel={result.threatIntel} />}

      {result.confirmedFamilies.length > 0 && (
        <FamilyAlert families={result.confirmedFamilies} />
      )}

      {/* Report header. */}
      <header className="surface flex items-start justify-between gap-4 p-5 max-[640px]:flex-col">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="caption">Scan report</span>
            <span aria-hidden="true" className="h-3 w-px bg-border" />
            <span className="text-[11.5px] font-medium text-status-ok">Complete</span>
          </div>

          <div
            className="break-all font-mono text-[16px] font-medium leading-[1.3] text-text"
            title={result.fileName}
          >
            {result.fileName}
          </div>

          <dl className="grid grid-cols-4 gap-x-6 gap-y-3 max-[720px]:grid-cols-2">
            <Field label="Size" value={formatBytes(result.fileSize)} />
            <Field
              label="Top severity"
              value={
                stats.topSeverity ? (
                  <span className={cn("capitalize", SEV_TEXT[stats.topSeverity])}>
                    {SEV_LABEL[stats.topSeverity]}
                  </span>
                ) : (
                  <span className="text-status-ok">None</span>
                )
              }
            />
            <Field
              label="Total hits"
              value={stats.totalHits.toLocaleString()}
            />
            <Field
              label={stats.uniqueArchives > 1 ? "Archives" : "Match types"}
              value={
                stats.uniqueArchives > 1
                  ? String(stats.uniqueArchives)
                  : String(stats.uniqueKinds)
              }
            />
          </dl>

          {result.sha256 && (
            <div className="flex items-center gap-2 pt-1">
              <Sha256Chip value={result.sha256} preview={24} />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onReset}
          className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] bg-status-ok px-4 py-2.5 text-[13px] font-semibold text-bg shadow-[0_0_0_1px_var(--color-status-ok-edge)] transition-[background,box-shadow,transform] duration-fast ease-out hover:bg-status-ok-bright hover:shadow-[0_0_0_4px_var(--color-status-ok-soft)] active:translate-y-[1px]"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path
              d="M6.5 2.5v8m0-8L3.5 5.5m3-3 3 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          New scan
        </button>
      </header>

      {/* Severity histogram. */}
      <div className="grid grid-cols-5 gap-2.5 max-[720px]:grid-cols-2">
        {ORDER.map((sev) => {
          const v = counts[sev];
          const pct = maxCount > 0 ? Math.max(4, (v / maxCount) * 100) : 0;
          return (
            <div
              key={sev}
              className={cn(
                "surface flex flex-col gap-2.5 p-3.5 transition-[opacity,border-color] duration-fast ease-out",
                v > 0 ? "hover:border-border" : "opacity-55",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-[11.5px] font-medium capitalize", SEV_TEXT[sev])}>
                  {sev}
                </span>
                <span className="tnum text-[11px] text-text-faint">
                  {String(v).padStart(2, "0")}
                </span>
              </div>
              <div className="tnum text-[28px] font-semibold leading-none tracking-[-0.03em] text-text">
                {v}
              </div>
              <div className={cn("relative h-1 w-full overflow-hidden rounded-full", SEV_BAR_SOFT[sev])}>
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 right-0 origin-left rounded-full transition-transform duration-slow ease-out",
                    SEV_BAR[sev],
                  )}
                  style={{ transform: `scaleX(${pct / 100})` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {result.confirmedFamilies.length === 0 && <SignatureDisclaimer />}

      {result.signatures.length === 0 ? (
        <div className="surface flex flex-col items-center gap-3 p-12 text-center">
          <span aria-hidden="true" className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[color:rgba(52,211,153,0.32)] bg-[color:rgba(52,211,153,0.08)] text-status-ok">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 8.5 6.5 12 13 4.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h3 className="m-0 text-[16px] font-semibold text-text">Nothing matched</h3>
          <p className="m-0 max-w-[400px] text-[13px] text-text-muted">
            None of the JLab signatures fired against this archive. That is a good sign, but not a guarantee.
          </p>
        </div>
      ) : (
        ORDER.map((sev) => {
          const sigs = grouped.get(sev) ?? [];
          if (sigs.length === 0) return null;

          return (
            <section key={sev} className="flex flex-col gap-2">
              <h3 className="m-0 flex items-center gap-3 px-1 pb-1 pt-1.5">
                <span className={cn("h-[14px] w-[3px] shrink-0 rounded-full", SEV_BAR[sev])} aria-hidden="true" />
                <span className={cn("text-[12.5px] font-semibold capitalize", SEV_TEXT[sev])}>
                  {SEV_LABEL[sev]}
                </span>
                <span className="tnum text-[11.5px] text-text-faint">
                  {String(sigs.length).padStart(2, "0")}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-border-faint" />
              </h3>
              <div className="flex flex-col gap-2">
                {sigs.map((sig) => (
                  <LazyMount key={sig.id} estimatedHeight={56}>
                    <SignatureCard signature={sig} />
                  </LazyMount>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="caption">{label}</dt>
      <dd className="m-0 text-[14px] font-medium tracking-[-0.005em] text-text">
        {value}
      </dd>
    </div>
  );
}
