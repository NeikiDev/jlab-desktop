import { useEffect, useRef, useState } from "react";
import { InfoIcon } from "./WatcherIcons";

interface Props {
  title?: string;
  children: React.ReactNode;
  align?: "left" | "right";
}

export default function InfoBubble({ title, children, align = "right" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={title ?? "More info"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-full border border-border-faint bg-bg-elev/60 px-2 text-[11px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-accent/40 hover:text-accent"
      >
        <InfoIcon />
        Info
      </button>
      {open && (
        <div
          role="dialog"
          style={{
            maxWidth: "min(320px, calc(100vw - 32px))",
            [align === "right" ? "right" : "left"]: 0,
          }}
          className="absolute top-[calc(100%+6px)] z-20 w-[320px] animate-fade-in rounded-[var(--radius-sm)] border border-border-faint bg-bg-plate p-3 text-[12px] leading-[1.55] text-text-muted shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          {title && (
            <div className="mb-1.5 text-[11.5px] font-semibold text-accent">
              {title}
            </div>
          )}
          <div>{children}</div>
        </div>
      )}
    </div>
  );
}
