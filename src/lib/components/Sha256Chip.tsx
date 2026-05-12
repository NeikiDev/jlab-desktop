import { useEffect, useRef, useState } from "react";
import { cn } from "../cn";

interface Props {
  value: string | null | undefined;
  /** How many leading hex chars to display before the ellipsis. */
  preview?: number;
  /** Optional class to override the base layout. */
  className?: string;
}

/**
 * Click-to-copy chip for a sha256.
 */
export default function Sha256Chip({ value, preview = 20, className }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  if (!value) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-text-dim">sha256</span>
        <span className="font-mono text-[11px] text-text-faint">-</span>
      </span>
    );
  }

  async function copy() {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const el = document.createElement("textarea");
        el.value = value;
        el.setAttribute("readonly", "");
        el.style.position = "absolute";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error("[Sha256Chip] clipboard write failed", e);
    }
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="text-[10px] font-medium text-text-dim">sha256</span>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : `Click to copy ${value}`}
        aria-label={copied ? "Copied to clipboard" : `Copy sha256 ${value}`}
        className={cn(
          "tnum inline-flex max-w-full cursor-pointer items-center gap-1.5 truncate rounded-full border px-2 py-[1px] font-mono text-[11px] transition-[background,border-color,color] duration-fast ease-out",
          copied
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-border-faint bg-bg-inset text-text-muted hover:border-accent/40 hover:text-accent",
        )}
      >
        <span className="truncate">
          {copied ? "copied" : `${value.slice(0, preview)}…`}
        </span>
        <span aria-hidden="true" className="text-[10px] leading-none">
          {copied ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5.2 4 7.2 8 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="2.6" y="2.6" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
              <path d="M4 1.5h3.5A1.5 1.5 0 0 1 9 3v3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </button>
    </span>
  );
}
