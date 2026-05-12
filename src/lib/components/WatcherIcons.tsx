// Small, single-stroke icons used by the watcher tiles. Inline so we ship
// no extra HTTP requests, and so they pick up `currentColor` from the
// surrounding text.

interface IconProps {
  className?: string;
}

const COMMON =
  "shrink-0";
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function BellIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function MinimizeIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      <path d="M12 14V4" />
      <path d="M8 10l4 4 4-4" />
    </svg>
  );
}

export function EyeOffIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10.5 10.5 0 0 1 22 12a10.5 10.5 0 0 1-4 5" />
      <path d="M6.1 6.1A10.5 10.5 0 0 0 2 12s3 7 10 7c1.7 0 3.2-.4 4.6-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function PowerIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M12 2v10" />
      <path d="M7 5a8 8 0 1 0 10 0" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

export function ClipboardIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg
      className={`${COMMON} ${className ?? ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      {...STROKE}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01" />
      <path d="M11 12h1v5h1" />
    </svg>
  );
}
