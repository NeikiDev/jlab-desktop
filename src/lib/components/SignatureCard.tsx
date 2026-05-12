import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Severity, Signature, SignatureMatch } from "../types";
import SeverityBadge from "./SeverityBadge";
import { cn } from "../cn";

const MATCH_CHUNK = 50;

const SEV_RAIL: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high:     "bg-sev-high",
  medium:   "bg-sev-medium",
  low:      "bg-sev-low",
  info:     "bg-sev-info",
};

const SNIPPET_BORDER: Record<Severity, string> = {
  critical: "border-l-sev-critical",
  high:     "border-l-sev-high",
  medium:   "border-l-sev-medium",
  low:      "border-l-sev-low",
  info:     "border-l-sev-info",
};

function hasContent(m: SignatureMatch): boolean {
  return Boolean(
    m.className ||
      m.member ||
      m.path ||
      m.matchedValue ||
      m.encoding ||
      m.original ||
      m.decoded,
  );
}

function splitJarPath(p: string): { outer: string | null; inner: string } {
  const idx = p.indexOf("!/");
  if (idx === -1) return { outer: null, inner: p };
  return { outer: p.slice(0, idx), inner: p.slice(idx + 2) };
}

function shortClass(c: string): string {
  return c.replaceAll("/", ".");
}

interface Props {
  signature: Signature;
}

function SignatureCardImpl({ signature }: Props) {
  const [open, setOpen] = useState(false);

  const visibleMatches = useMemo(
    () => signature.matches.filter(hasContent),
    [signature.matches],
  );
  const hiddenCount = signature.matches.length - visibleMatches.length;

  const [shownCount, setShownCount] = useState(MATCH_CHUNK);
  useEffect(() => {
    if (open) setShownCount(MATCH_CHUNK);
  }, [open, signature.id]);

  const trimmedMatches = visibleMatches.slice(0, shownCount);
  const remainingCount = Math.max(0, visibleMatches.length - shownCount);

  const matchSentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (remainingCount === 0) return;
    const el = matchSentinel.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShownCount(visibleMatches.length);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShownCount((n) => Math.min(n + MATCH_CHUNK, visibleMatches.length));
        }
      },
      { rootMargin: "300px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, remainingCount, visibleMatches.length]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius)] border bg-bg-plate transition-[border-color,background] duration-fast ease-out [contain:layout_paint] [content-visibility:auto] [contain-intrinsic-size:64px]",
        open ? "border-border bg-bg-elev/60" : "border-border-faint hover:border-border",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-[2.5px]", SEV_RAIL[signature.severity])}
      />

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="block w-full cursor-pointer border-0 bg-transparent px-4 py-3 pl-[18px] text-left text-text transition-colors duration-fast ease-out hover:bg-bg-elev/40 focus-visible:[outline:1.5px_solid_var(--color-accent)] focus-visible:[outline-offset:-2px]"
      >
        <span className="flex w-full items-center justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-center gap-2.5">
            <SeverityBadge severity={signature.severity} />
            {signature.kind && (
              <span className="rounded-full border border-border-faint bg-bg-elev/60 px-2 py-[2px] text-[10.5px] font-medium text-text-dim">
                {signature.kind}
              </span>
            )}
            {signature.family && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-2 py-[2px] text-[10.5px] font-semibold text-sev-critical">
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 1.2 11 10H1L6 1.2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                {signature.family}
              </span>
            )}
            <span className="min-w-[120px] flex-1 truncate text-[14px] font-medium tracking-[-0.005em] text-text">
              {signature.name}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-text-muted">
            <span className="tnum inline-flex items-baseline gap-1 rounded-full border border-border-faint bg-bg-inset px-2 py-[2px] text-[11px] font-semibold text-text">
              <span className="text-text-faint">&times;</span>
              {signature.count}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex text-text-dim transition-[transform,color] duration-base ease-out",
                open && "rotate-180 text-accent",
              )}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 4.5 6 7.5 9 4.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </span>
        </span>

        {signature.description && (
          <span className="mt-1.5 block text-[13px] leading-[1.55] text-text-muted">
            {signature.description}
          </span>
        )}
      </button>

      {open && (
        <div className="animate-fade-in border-t border-border-faint bg-bg-inset/40 px-4 py-3 pl-[18px]">
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <MetaPair label="ID" value={signature.id} mono />
            <MetaPair label="Kind" value={signature.kind || "-"} />
            <MetaPair label="Hits" value={String(signature.count)} mono />
            {signature.family && (
              <MetaPair label="Family" value={signature.family} mono accent />
            )}
          </div>

          {trimmedMatches.length > 0 ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="caption">Matches</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border-faint" />
                <span className="tnum text-[11px] text-text-faint">
                  {trimmedMatches.length} of {visibleMatches.length}
                </span>
              </div>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {trimmedMatches.map((m, i) => {
                  const parts = m.path ? splitJarPath(m.path) : null;
                  return (
                    <li
                      key={i}
                      className="grid grid-cols-[32px_1fr] gap-2.5 rounded-[var(--radius-sm)] border border-border-faint bg-bg-plate p-2.5 transition-colors duration-fast ease-out hover:border-border"
                    >
                      <span className="tnum select-none font-mono text-[10.5px] leading-[1.7] text-text-faint">
                        {String(i + 1).padStart(3, "0")}
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        {m.className && (
                          <Row label="Class">
                            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-accent">
                              {shortClass(m.className)}
                            </code>
                          </Row>
                        )}
                        {m.member && (
                          <Row label="Member">
                            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-text-muted">
                              {m.member}
                            </code>
                          </Row>
                        )}
                        {parts && (
                          <Row label="Path">
                            <span className="inline-flex min-w-0 flex-1 flex-wrap items-baseline">
                              {parts.outer && (
                                <>
                                  <code className="font-mono text-[12.5px] text-text-muted">
                                    {parts.outer}
                                  </code>
                                  <span className="px-0.5 font-mono text-[12.5px] text-text-faint">
                                    !/
                                  </span>
                                </>
                              )}
                              <code className="break-all font-mono text-[12.5px] text-accent">
                                {parts.inner}
                              </code>
                            </span>
                          </Row>
                        )}
                        {m.matchedValue && (
                          <div
                            className={cn(
                              "mt-0.5 overflow-hidden rounded-[var(--radius-xs)] border border-border-faint border-l-2 bg-bg-inset px-2.5 py-1.5",
                              SNIPPET_BORDER[signature.severity],
                            )}
                          >
                            <code className="block whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-text-muted">
                              {m.matchedValue}
                            </code>
                          </div>
                        )}
                        {m.encoding && (
                          <Row label="Encoding">
                            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-text-muted">
                              {m.encoding}
                            </code>
                          </Row>
                        )}
                        {m.original && (
                          <div
                            className={cn(
                              "mt-0.5 overflow-hidden rounded-[var(--radius-xs)] border border-border-faint border-l-2 bg-bg-inset px-2.5 py-1.5",
                              SNIPPET_BORDER[signature.severity],
                            )}
                          >
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-faint">
                              Encoded
                            </div>
                            <code className="block whitespace-pre-wrap break-all font-mono text-[12px] leading-[1.5] text-text-muted">
                              {m.original}
                            </code>
                          </div>
                        )}
                        {m.decoded && (
                          <div
                            className={cn(
                              "mt-0.5 overflow-hidden rounded-[var(--radius-xs)] border border-border-faint border-l-2 bg-bg-inset px-2.5 py-1.5",
                              SNIPPET_BORDER[signature.severity],
                            )}
                          >
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-faint">
                              Decoded
                            </div>
                            <code className="block whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-accent">
                              {m.decoded}
                            </code>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {remainingCount > 0 && (
                <div
                  ref={matchSentinel}
                  className="mt-2 text-[12px] text-text-faint"
                >
                  Loading {Math.min(MATCH_CHUNK, remainingCount)} more, {remainingCount} remaining
                </div>
              )}
            </>
          ) : (
            <div className="rounded-[var(--radius-sm)] border border-dashed border-border-faint bg-bg-plate p-3 text-[12.5px] leading-[1.5] text-text-muted">
              No specific location was recorded for this match.
              {signature.count > 1 && (
                <> The {signature.count} hits come from the archive as a whole.</>
              )}
            </div>
          )}

          {hiddenCount > 0 && visibleMatches.length > 0 && (
            <div className="mt-2 text-[12px] text-text-faint">
              +{hiddenCount} hit{hiddenCount === 1 ? "" : "s"} without location data
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-2">
      <span className="w-[50px] shrink-0 text-[10.5px] font-medium text-text-faint">
        {label}
      </span>
      {children}
    </div>
  );
}

function MetaPair({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-medium text-text-faint">{label}</span>
      <span
        className={cn(
          "text-[12.5px]",
          mono && "font-mono",
          accent ? "text-sev-critical" : "text-text-muted",
        )}
      >
        {value}
      </span>
    </span>
  );
}

const SignatureCard = memo(SignatureCardImpl);
export default SignatureCard;
