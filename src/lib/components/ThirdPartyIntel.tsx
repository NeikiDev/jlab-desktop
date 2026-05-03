import { useMemo } from "react";
import type {
  RatterGithubInfo,
  RatterScannerIntel,
  ThreatIntel,
  ThreatRipIntel,
  VirusTotalIntel,
} from "../types";
import { openUrl } from "../api";
import { cn } from "../cn";

interface Props {
  intel: ThreatIntel;
}

type Tone = "ok" | "warn" | "bad" | "neutral";

const TONE_BORDER: Record<Tone, string> = {
  ok:      "border-[color:rgba(52,211,153,0.32)]",
  warn:    "border-[color:var(--color-sev-medium-edge)]",
  bad:     "border-[color:var(--color-sev-critical-edge)]",
  neutral: "border-border",
};

const TONE_TEXT: Record<Tone, string> = {
  ok:      "text-status-ok",
  warn:    "text-sev-medium",
  bad:     "text-sev-critical",
  neutral: "text-text-muted",
};

const TONE_DOT: Record<Tone, string> = {
  ok:      "bg-status-ok",
  warn:    "bg-sev-medium",
  bad:     "bg-sev-critical",
  neutral: "bg-text-faint",
};

const VERDICT_BAD = new Set(["malware", "malicious", "high", "critical"]);
const VERDICT_WARN = new Set([
  "suspicious",
  "unknown",
  "medium",
  "low",
  "warn",
  "warning",
  "potentially_unwanted",
  "potentially-unwanted",
]);

function classifyVerdict(verdict?: string | null): Tone {
  if (!verdict) return "neutral";
  const v = verdict.toLowerCase();
  if (VERDICT_BAD.has(v)) return "bad";
  if (VERDICT_WARN.has(v)) return "warn";
  if (v === "clean" || v === "safe" || v === "benign" || v === "ok") return "ok";
  return "neutral";
}

function classifyRatter(rs: RatterScannerIntel): Tone {
  if (rs.malicious) return "bad";
  if (rs.safe || rs.automatedSafe) return "ok";
  return "warn";
}

function classifyVirusTotal(vt: VirusTotalIntel): Tone {
  if (!vt.available) return "neutral";
  const detections = vt.detections ?? 0;
  if (detections >= 3) return "bad";
  if (detections >= 1 || (vt.suspicious ?? 0) >= 1) return "warn";
  return "ok";
}

function formatPercent(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export default function ThirdPartyIntel({ intel }: Props) {
  const cards = useMemo(() => {
    const out: { key: string; node: React.ReactNode; tone: Tone }[] = [];
    const sha = intel.sha256 ?? null;
    if (intel.virusTotal?.available) {
      const tone = classifyVirusTotal(intel.virusTotal);
      out.push({
        key: "vt",
        tone,
        node: <VirusTotalCard vt={intel.virusTotal} tone={tone} sha256={sha} />,
      });
    }
    if (intel.threatRip?.available) {
      const tone = classifyVerdict(intel.threatRip.verdict);
      out.push({
        key: "tr",
        tone,
        node: <ThreatRipCard tr={intel.threatRip} tone={tone} sha256={sha} />,
      });
    }
    if (intel.ratterScanner?.available) {
      const tone = classifyRatter(intel.ratterScanner);
      out.push({
        key: "rs",
        tone,
        node: <RatterCard rs={intel.ratterScanner} tone={tone} />,
      });
    }
    return out;
  }, [intel]);

  const overall: Tone = useMemo(() => {
    if (cards.some((c) => c.tone === "bad")) return "bad";
    if (cards.some((c) => c.tone === "warn")) return "warn";
    if (cards.some((c) => c.tone === "ok")) return "ok";
    return "neutral";
  }, [cards]);

  if (cards.length === 0) return null;

  const headline =
    overall === "bad"
      ? "Threats Detected"
      : overall === "warn"
      ? "Possible Threats"
      : overall === "ok"
      ? "No Threats Detected"
      : "Third-Party Intel";

  return (
    <section
      aria-label="Third-party threat intel"
      className={cn(
        "bracketed relative flex animate-rise-in flex-col gap-3 overflow-hidden rounded-[var(--radius-lg)] border bg-bg-plate p-4 px-5",
        TONE_BORDER[overall],
      )}
    >
      <span className="bracket-bl" aria-hidden="true" />
      <span className="bracket-br" aria-hidden="true" />

      <header className="flex items-center gap-2.5">
        <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", TONE_DOT[overall])} />
        <span className={cn("font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em]", TONE_TEXT[overall])}>
          third-party intel
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-border" />
        <span className="text-[14px] font-semibold tracking-[-0.005em] text-text">
          {headline}
        </span>
        <span className="tnum ml-auto font-mono text-[11px] text-text-faint">
          {String(cards.length).padStart(2, "0")} {cards.length === 1 ? "source" : "sources"}
        </span>
      </header>

      <div
        className={cn(
          "grid gap-2",
          cards.length === 1
            ? "grid-cols-1"
            : cards.length === 2
            ? "grid-cols-2 max-[640px]:grid-cols-1"
            : "grid-cols-3 max-[820px]:grid-cols-2 max-[520px]:grid-cols-1",
        )}
      >
        {cards.map((c) => (
          <div key={c.key}>{c.node}</div>
        ))}
      </div>
    </section>
  );
}

function CardShell({
  tone,
  vendor,
  domain,
  reportUrl,
  reportLabel,
  children,
}: {
  tone: Tone;
  vendor: string;
  domain?: string;
  reportUrl?: string | null;
  reportLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <article
      className={cn(
        "flex h-full flex-col gap-2.5 rounded-[var(--radius)] border bg-bg-elev p-3 transition-[border-color] duration-fast ease-out",
        TONE_BORDER[tone],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold tracking-[-0.005em] text-text">
            {vendor}
          </span>
          {domain && (
            <span className="font-mono text-[10.5px] text-text-dim">{domain}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {reportUrl && <ViewButton url={reportUrl} label={reportLabel} />}
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} />
        </div>
      </div>
      {children}
    </article>
  );
}

function ViewButton({ url, label = "View" }: { url: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void openUrl(url);
      }}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-xs)] border border-border bg-bg-plate px-2 py-1 font-mono text-[10.5px] font-medium tracking-[0.02em] text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border-strong hover:bg-bg-hover hover:text-text active:translate-y-[1px]"
      aria-label={`${label} in browser`}
    >
      {label}
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
        <path
          d="M3 1.5h4.5V6M7.5 1.5 1.5 7.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function VirusTotalCard({
  vt,
  tone,
  sha256,
}: {
  vt: VirusTotalIntel;
  tone: Tone;
  sha256: string | null;
}) {
  const total = vt.totalScanners ?? 0;
  const detections = vt.detections ?? 0;
  const pct = formatPercent(detections, total);
  const label =
    detections === 0 ? "No detections" : `${detections} detection${detections === 1 ? "" : "s"}`;
  const reportUrl = sha256 ? `https://www.virustotal.com/gui/file/${sha256}` : null;
  return (
    <CardShell tone={tone} vendor="VirusTotal" domain="virustotal.com" reportUrl={reportUrl}>
      <div className="flex items-baseline gap-2">
        <span className={cn("tnum text-[26px] font-semibold leading-none tracking-[-0.03em]", TONE_TEXT[tone])}>
          {detections}
        </span>
        <span className="font-mono text-[12px] text-text-muted">/ {total || "?"}</span>
        <span className="ml-auto tnum font-mono text-[11px] text-text-dim">{pct}</span>
      </div>
      <div className="text-[12px] text-text-muted">{label}</div>
      <div className="flex flex-wrap gap-1 pt-0.5">
        <Stat label="malicious" value={vt.malicious} />
        <Stat label="suspicious" value={vt.suspicious} />
        <Stat label="undetected" value={vt.undetected} />
        {typeof vt.reputation === "number" && (
          <Stat label="reputation" value={vt.reputation} />
        )}
      </div>
    </CardShell>
  );
}

function ThreatRipCard({
  tr,
  tone,
  sha256,
}: {
  tr: ThreatRipIntel;
  tone: Tone;
  sha256: string | null;
}) {
  const verdict = tr.verdict ?? "Unknown";
  const score = typeof tr.threatScore === "number" ? tr.threatScore : null;
  const hash = sha256 ?? tr.sha256 ?? null;
  const reportUrl = hash ? `https://www.threat.rip/file/${hash}` : null;
  return (
    <CardShell
      tone={tone}
      vendor="Threat Insights Portal"
      domain="www.threat.rip"
      reportUrl={reportUrl}
    >
      <div className="flex items-baseline gap-2">
        <span className={cn("text-[15px] font-semibold tracking-[-0.005em] uppercase", TONE_TEXT[tone])}>
          {verdict}
        </span>
        {score !== null && (
          <span className="ml-auto tnum font-mono text-[11px] text-text-dim">
            score <span className="text-text">{score}</span>
            <span className="text-text-faint">/100</span>
          </span>
        )}
      </div>
      {tr.threat ? (
        <div className="font-mono text-[12px] text-text break-all">{tr.threat}</div>
      ) : (
        <div className="text-[12px] text-text-muted">No known family attribution.</div>
      )}
      {score !== null && (
        <div className="relative mt-1 h-[3px] w-full overflow-hidden rounded-[2px] bg-bg-inset">
          <div
            className={cn(
              "absolute inset-y-0 left-0 origin-left rounded-[2px] transition-[width] duration-slow ease-out",
              tone === "bad" ? "bg-sev-critical" : tone === "warn" ? "bg-sev-medium" : "bg-status-ok",
            )}
            style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
          />
        </div>
      )}
    </CardShell>
  );
}

function RatterCard({ rs, tone }: { rs: RatterScannerIntel; tone: Tone }) {
  const headline = rs.malicious
    ? "Malicious"
    : rs.safe
      ? "Whitelisted"
      : rs.automatedSafe
        ? "Automated Safe"
        : "Unverified";
  const subtitle = rs.malicious
    ? "Known malicious sample"
    : rs.safe
      ? "Verified safe source"
      : rs.automatedSafe
        ? "Heuristic deems this safe"
        : "No verdict from RatterScanner";
  const repoUrl = rs.githubInfo?.repoUrl ?? null;
  return (
    <CardShell
      tone={tone}
      vendor="RatterScanner"
      domain="ratterscanner.com"
      reportUrl={repoUrl}
      reportLabel="Visit"
    >
      <div className="flex flex-wrap items-stretch gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span
            className={cn(
              "text-[18px] font-semibold leading-tight tracking-[-0.01em]",
              TONE_TEXT[tone],
            )}
          >
            {headline}
          </span>
          <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <span
              aria-hidden="true"
              className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])}
            />
            {subtitle}
          </div>
        </div>
        {rs.githubInfo && <RatterGithubPanel info={rs.githubInfo} />}
      </div>
    </CardShell>
  );
}

function RatterGithubPanel({ info }: { info: RatterGithubInfo }) {
  const project = info.projectName ?? info.name ?? "GitHub Project";
  const owner = info.owner ?? null;
  const repoUrl = info.repoUrl ?? null;
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-1 rounded-[var(--radius-xs)] border border-border-faint bg-bg-inset px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-text-muted">
        <GithubMark />
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-dim">
          Verified Source
        </span>
      </div>
      {repoUrl ? (
        <button
          type="button"
          onClick={() => {
            void openUrl(repoUrl);
          }}
          className="cursor-pointer truncate text-left text-[13px] font-medium text-sev-low hover:underline"
          title={repoUrl}
        >
          {project}
        </button>
      ) : (
        <span className="truncate text-[13px] font-medium text-text">{project}</span>
      )}
      {owner && (
        <span className="truncate font-mono text-[10.5px] text-text-dim">by {owner}</span>
      )}
    </div>
  );
}

function GithubMark() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.69-.01-1.36-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return null;
  return (
    <span className="inline-flex items-baseline gap-1 rounded-[var(--radius-xs)] border border-border-faint bg-bg-inset px-1.5 py-0.5 font-mono text-[10.5px] text-text-muted">
      <span className="text-text-faint">{label}</span>
      <span className="tnum text-text">{value}</span>
    </span>
  );
}
