/**
 * The JLab brand mark. White J glyph on a quiet near-black tile with a
 * faint hairline border. Matches the monochrome dashboard aesthetic.
 */
export default function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-border-strong bg-bg-elev text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M10.5 2.6v6.5a3.4 3.4 0 0 1-3.4 3.4H5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <circle cx="10.5" cy="2.6" r="1.1" fill="currentColor" />
      </svg>
    </span>
  );
}
