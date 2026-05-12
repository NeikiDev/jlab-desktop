import type { ConfirmedFamily } from "../types";

interface Props {
  families: ConfirmedFamily[];
}

export default function FamilyAlert({ families }: Props) {
  if (families.length === 0) return null;

  const single = families.length === 1 ? families[0] : null;
  const title = single ? single.name : "Confirmed malware";

  return (
    <section
      role="alert"
      aria-label="Confirmed malware family detected"
      className="relative flex animate-rise-in flex-col gap-3 overflow-hidden rounded-[var(--radius)] border border-[color:var(--color-sev-critical-edge)] p-5 shadow-[0_0_0_1px_rgba(255,93,108,0.10),0_8px_28px_rgba(255,93,108,0.10)]"
      style={{
        background:
          "linear-gradient(180deg, rgba(255, 93, 108, 0.14), rgba(255, 93, 108, 0.04))",
      }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px] bg-sev-critical"
        aria-hidden="true"
      />

      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--color-sev-critical-edge)] bg-bg-plate/50 text-sev-critical"
        >
          <svg width="22" height="22" viewBox="0 0 18 18" fill="none">
            <path d="M9 1.5 16.5 15h-15L9 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9 7v3.5M9 12.5h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center rounded-full border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-2.5 py-[3px] text-[10.5px] font-semibold uppercase tracking-[0.06em] text-sev-critical">
            Confirmed malware
          </span>

          <h3
            className="mt-2.5 mb-0 break-words text-[26px] font-semibold leading-[1.15] tracking-[-0.015em] text-text"
            title={title}
          >
            {title}
          </h3>

          <p className="mt-2 mb-0 text-[13.5px] leading-[1.55] text-text-muted">
            {single ? (
              <>
                Identified as{" "}
                <span className="font-semibold text-text">{single.name}</span>.
                Do not run, install, or distribute this file.
              </>
            ) : (
              <>
                Identified as{" "}
                {families.map((fam, i) => (
                  <span key={fam.name}>
                    <span className="font-semibold text-text">{fam.name}</span>
                    {i < families.length - 2
                      ? ", "
                      : i === families.length - 2
                        ? ", and "
                        : ""}
                  </span>
                ))}
                . Do not run, install, or distribute this file.
              </>
            )}
          </p>
        </div>
      </div>

      <p className="m-0 border-t border-[color:var(--color-sev-critical-edge)]/50 pt-3 text-[12px] leading-[1.5] text-text-faint">
        Individual signature names and counts are hidden for confirmed families to prevent bypass attempts.
      </p>
    </section>
  );
}
