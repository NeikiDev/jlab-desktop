import { useCallback, useEffect, useState } from "react";
import { clearLogs, logDirSize, openLogDir } from "../api";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function LogControl() {
  const [size, setSize] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSize(await logDirSize());
    } catch {
      setSize(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleOpen() {
    try {
      await openLogDir();
    } catch (e) {
      console.error("[LogControl] open failed", e);
    }
  }

  async function handleClear() {
    setBusy(true);
    try {
      await clearLogs();
      await refresh();
    } catch (e) {
      console.error("[LogControl] clear failed", e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const sizeLabel = size === null ? "logs" : `logs ${formatBytes(size)}`;

  return (
    <div className="inline-flex items-center gap-1.5 font-mono tracking-[0.04em] text-text-dim">
      <span className="tnum text-text-muted">{sizeLabel}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={handleOpen}
        title="Open the log folder"
        className="cursor-pointer rounded-sm border-0 bg-transparent px-1 py-0.5 text-text-muted transition-colors duration-fast ease-out hover:text-text"
      >
        open
      </button>
      <span aria-hidden="true">·</span>
      {confirming ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={handleClear}
            title="Delete rotated logs and reset the active log file"
            className="cursor-pointer rounded-sm border border-[color:var(--color-sev-critical-edge)] bg-sev-critical-soft px-1.5 py-0.5 text-sev-critical transition-colors duration-fast ease-out hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            confirm clear
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded-sm border-0 bg-transparent px-1 py-0.5 text-text-muted transition-colors duration-fast ease-out hover:text-text"
          >
            cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="Delete rotated logs and reset the active log"
          className="cursor-pointer rounded-sm border-0 bg-transparent px-1 py-0.5 text-text-muted transition-colors duration-fast ease-out hover:text-text"
        >
          clear
        </button>
      )}
    </div>
  );
}
