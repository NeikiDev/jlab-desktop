import { DISCORD_URL, openUrl } from "../api";

export default function SignatureDisclaimer() {
  return (
    <section
      role="note"
      aria-label="Signature matches are not a final verdict"
      className="relative flex animate-rise-in items-start gap-3.5 overflow-hidden rounded-[var(--radius)] border border-[color:var(--color-sev-medium-edge)] bg-[color:var(--color-sev-medium-soft)] p-4 px-5"
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px] bg-sev-medium"
        aria-hidden="true"
      />

      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[color:var(--color-sev-medium-edge)] bg-bg-plate/50 text-sev-medium"
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
          <path d="M9 1.5 16.5 15h-15L9 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M9 7v3.5M9 12.5h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>

      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-text-muted">
        <p className="m-0 text-[13.5px] font-semibold text-sev-medium tracking-[-0.005em]">
          Signature matches alone are not a final verdict.
        </p>
        <p className="mt-1.5 mb-0">
          A single hit (for example one Weedhack RAT signature) does not mean the whole file is malware. Signatures can produce false positives, so review flagged findings manually before drawing conclusions.
        </p>
        <p className="mt-1.5 mb-0">
          <span className="font-semibold text-text">Exception:</span> if a{" "}
          <span className="font-semibold text-sev-critical">
            &ldquo;Confirmed malware&rdquo;
          </span>{" "}
          box is shown, that family has been reliably identified and can be treated as confirmed.
        </p>
        <p className="mt-1.5 mb-0">
          Questions about a specific finding? Join our{" "}
          <button
            type="button"
            onClick={() => void openUrl(DISCORD_URL)}
            className="cursor-pointer font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded-[2px]"
          >
            Discord
          </button>{" "}and open a ticket.
        </p>
      </div>
    </section>
  );
}
