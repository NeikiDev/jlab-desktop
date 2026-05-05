import { DISCORD_URL, openUrl } from "../api";

interface Props {
  hasConfirmedFamily: boolean;
}

export default function SignatureDisclaimer({ hasConfirmedFamily }: Props) {
  return (
    <section
      role="note"
      aria-label="Signature matches are not a final verdict"
      className="bracketed relative flex animate-rise-in items-start gap-3 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-sev-medium-edge)] bg-[color:var(--color-sev-medium-soft)] p-4 px-5"
    >
      <span className="bracket-bl" aria-hidden="true" />
      <span className="bracket-br" aria-hidden="true" />
      <span
        className="absolute inset-y-0 left-0 w-[3px] bg-sev-medium"
        aria-hidden="true"
      />

      <span
        aria-hidden="true"
        className="mt-[2px] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-[color:var(--color-sev-medium-edge)] bg-bg-plate/50 text-sev-medium"
      >
        <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
          <path
            d="M9 1.5 16.5 15h-15L9 1.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M9 7v3.5M9 12.5h.01"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>

      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-text-muted">
        <p
          className="m-0 text-[13.5px] font-semibold tracking-[-0.005em] text-sev-medium"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Signature matches alone are not a final verdict.
        </p>
        <p className="mt-1.5 mb-0">
          A single hit (for example one Weedhack RAT signature) does not mean
          the whole file is malware. Signatures can produce false positives, so
          please review flagged findings manually before drawing conclusions.
        </p>
        <p className="mt-1.5 mb-0">
          <span className="font-semibold text-text">Exception:</span>{" "}
          {hasConfirmedFamily ? (
            <>
              the{" "}
              <span className="font-semibold text-sev-critical">
                &ldquo;Malware family confirmed&rdquo;
              </span>{" "}
              box above identifies a known family through its signatures and
              can be treated as confirmed.
            </>
          ) : (
            <>
              if a{" "}
              <span className="font-semibold text-sev-critical">
                &ldquo;Malware family confirmed&rdquo;
              </span>{" "}
              box is shown, that family has been reliably identified through
              its signatures and can be treated as confirmed.
            </>
          )}
        </p>
        <p className="mt-1.5 mb-0">
          Questions about a specific finding? Join our{" "}
          <button
            type="button"
            onClick={() => void openUrl(DISCORD_URL)}
            className="cursor-pointer font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-[2px]"
          >
            Discord
          </button>{" "}
          and open a ticket.
        </p>
      </div>
    </section>
  );
}
