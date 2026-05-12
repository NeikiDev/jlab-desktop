import { useEffect } from "react";
import { openUrl } from "../api";
import { BellIcon, LockIcon, RefreshIcon, ShieldIcon, TrashIcon } from "./WatcherIcons";

interface Props {
  onCancel: () => void;
  onConfirm: () => void;
}

const DISCORD_URL = "https://www.threat.rip/discord";

interface Point {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

const POINTS: Point[] = [
  {
    icon: <ShieldIcon />,
    title: "Signature-based only",
    body: (
      <>
        The scanner catches known signatures. New, repacked, or heavily obfuscated payloads can slip through. A clean result is not a guarantee.
      </>
    ),
  },
  {
    icon: <BellIcon />,
    title: "New files only",
    body: (
      <>
        Auto-scan only sees files added or modified after watching starts. Existing files are ignored unless you click <strong>Scan all now</strong>.
      </>
    ),
  },
  {
    icon: <RefreshIcon />,
    title: "Rate limited",
    body: <>Auto-scans are capped at 12 requests per minute. Bursts get queued, not dropped.</>,
  },
  {
    icon: <TrashIcon />,
    title: "You own destructive actions",
    body: (
      <>
        JLab Desktop never deletes or kills anything by itself, unless you turn on the auto-delete option. You decide on every alert.
      </>
    ),
  },
  {
    icon: <LockIcon />,
    title: "Human judgement still needed",
    body: <>Open each result, look at the matches, and decide.</>,
  },
];

export default function WatcherFirstEnableModal({ onCancel, onConfirm }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,5,10,0.72)] p-5 animate-fade-in backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="watcher-warning-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="relative flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-sev-medium-edge bg-bg-plate text-text shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        <header className="flex items-start gap-4 border-b border-border-faint px-6 py-5">
          <span
            aria-hidden="true"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-sev-medium-edge bg-sev-medium-soft text-sev-medium"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2 1 21h22L12 2z" />
              <path d="M12 9v5" />
              <path d="M12 18h.01" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-sev-medium">
              Before you start
            </div>
            <h2
              id="watcher-warning-title"
              className="m-0 text-[21px] font-semibold leading-[1.25] tracking-[-0.005em] text-text"
            >
              Heads up: this is not an antivirus
            </h2>
            <p className="m-0 mt-2 text-[14.5px] leading-[1.55] text-text-muted">
              The folder watcher reuses the JLab static scanner. It helps spot known threats fast, but it is not a replacement for an antivirus or for your own judgement.
            </p>
          </div>
        </header>

        <ul className="m-0 flex list-none flex-col gap-2 overflow-y-auto px-6 py-5 pl-6">
          {POINTS.map((p) => (
            <li
              key={p.title}
              className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/40 p-3"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 text-text-muted"
              >
                {p.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold leading-[1.3] text-text tracking-[-0.005em]">
                  {p.title}
                </div>
                <p className="m-0 mt-1 text-[13.5px] leading-[1.55] text-text-muted">
                  {p.body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-faint bg-bg-elev/40 px-6 py-4">
          <button
            type="button"
            onClick={() => void openUrl(DISCORD_URL)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-accent underline-offset-[3px] hover:text-accent-bright hover:underline"
          >
            Questions? Join our Discord
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-4 py-2.5 text-[13.5px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              autoFocus
              className="cursor-pointer rounded-[var(--radius-sm)] border border-status-ok-edge bg-status-ok-soft px-4 py-2.5 text-[13.5px] font-semibold text-status-ok transition-[background,border-color,box-shadow,color,transform] duration-fast ease-out hover:border-status-ok hover:bg-[color:var(--color-status-ok)] hover:text-bg hover:shadow-[0_0_0_3px_var(--color-status-ok-soft)] active:translate-y-[1px]"
            >
              Enable watching
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
