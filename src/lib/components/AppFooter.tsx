import { useEffect, useState } from "react";
import { appVersion, openUrl } from "../api";
import LogControl from "./LogControl";

const RELEASES_URL = "https://github.com/NeikiDev/jlab-desktop/releases";

export default function AppFooter() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await appVersion();
        if (!cancelled) setVersion(v);
      } catch {
        /* footer is decorative */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;

  return (
    <footer className="relative flex shrink-0 items-center justify-between gap-3 border-t border-border-faint bg-bg-plate/40 px-7 py-2 text-[11px] text-text-dim backdrop-blur-[6px]">
      <span>JLab Desktop</span>
      <div className="flex items-center gap-3">
        <LogControl />
        <button
          type="button"
          onClick={() => void openUrl(RELEASES_URL)}
          title="Open the GitHub releases page"
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-1 py-0.5 text-text-muted transition-colors duration-fast ease-out hover:text-text"
        >
          v{version}
        </button>
      </div>
    </footer>
  );
}
