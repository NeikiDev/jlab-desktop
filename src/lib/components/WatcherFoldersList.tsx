import { useEffect, useRef, useState } from "react";
import type { WatchedFolder } from "../types";
import {
  watcherAddFolder,
  watcherPickFolder,
  watcherRemoveFolder,
  watcherScanAllNow,
  watcherShowInFolder,
} from "../api";
import { ClipboardIcon, FolderIcon, PlusIcon } from "./WatcherIcons";
import { cn } from "../cn";

interface Props {
  folders: WatchedFolder[];
  onChanged: () => void;
  onError: (msg: string) => void;
}

export default function WatcherFoldersList({ folders, onChanged, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  function cancel() {
    setAdding(false);
    setPasted("");
  }

  async function browse() {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await watcherPickFolder();
      if (!picked) return;
      await watcherAddFolder(picked);
      onChanged();
      cancel();
    } catch (e) {
      onError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setPasted(text.trim());
      inputRef.current?.focus();
    } catch {
      onError(
        "Could not read the clipboard. Paste the path into the field with Cmd+V / Ctrl+V instead.",
      );
    }
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const path = pasted.trim();
    if (!path) {
      onError("Please paste or type a folder path.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await watcherAddFolder(path);
      onChanged();
      cancel();
    } catch (e) {
      onError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    if (busy) return;
    setBusy(true);
    try {
      await watcherRemoveFolder(path);
      onChanged();
    } catch (e) {
      onError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function scanAll(path: string) {
    try {
      await watcherScanAllNow(path);
    } catch (e) {
      onError(String((e as { message?: string })?.message ?? e));
    }
  }

  return (
    <section className="frame flex h-full min-h-0 flex-col p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-dim">
          Watched folders
        </h3>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={busy}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border px-3.5 py-2 text-[13.5px] font-semibold transition-[background,border-color,box-shadow,color] duration-fast ease-out",
              busy
                ? "border-border-faint bg-bg-inset text-text-faint"
                : "border-status-ok-edge bg-status-ok-soft text-status-ok hover:border-status-ok hover:bg-[color:var(--color-status-ok)] hover:text-bg hover:shadow-[0_0_0_3px_var(--color-status-ok-soft)]",
            )}
          >
            <PlusIcon />
            Add folder
          </button>
        ) : (
          <span className="text-[13px] text-text-faint">Adding…</span>
        )}
      </header>

      {adding && (
        <form
          onSubmit={submit}
          className="mb-3 flex flex-col gap-3 rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/40 p-4 animate-fade-in"
        >
          <label className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-text-dim">
              Folder path
            </span>
            <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border-faint bg-bg-inset px-3 py-2.5 transition-[border-color,box-shadow] duration-fast ease-out focus-within:border-status-ok-edge focus-within:shadow-[0_0_0_3px_var(--color-status-ok-soft)]">
              <FolderIcon className="text-text-faint" />
              <input
                ref={inputRef}
                type="text"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="/Users/you/.minecraft/mods"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[14px] text-text outline-none! placeholder:text-text-faint focus:outline-none! focus-visible:outline-none!"
              />
              <button
                type="button"
                onClick={() => void pasteFromClipboard()}
                title="Paste from clipboard"
                className="inline-flex cursor-pointer items-center gap-1 rounded-[3px] border border-border-faint bg-bg-elev/60 px-2.5 py-1.5 text-[12px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-accent/40 hover:text-accent"
              >
                <ClipboardIcon />
                Paste
              </button>
            </div>
          </label>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void browse()}
              disabled={busy}
              className="cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-elev/60 px-3.5 py-2 text-[13.5px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-border hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              Browse…
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="cursor-pointer rounded-[var(--radius-sm)] border border-transparent bg-transparent px-3.5 py-2 text-[13.5px] font-medium text-text-muted transition-[background,color] duration-fast ease-out hover:bg-bg-elev/60 hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || pasted.trim().length === 0}
              className={cn(
                "cursor-pointer rounded-[var(--radius-sm)] border px-3.5 py-2 text-[13.5px] font-semibold transition-[background,border-color,color,transform] duration-fast ease-out active:translate-y-[1px]",
                busy || pasted.trim().length === 0
                  ? "cursor-not-allowed border-border-faint bg-bg-inset text-text-faint"
                  : "border-status-ok-edge bg-status-ok-soft text-status-ok hover:border-status-ok hover:bg-[color:var(--color-status-ok)] hover:text-bg",
              )}
            >
              Add
            </button>
          </div>
        </form>
      )}

      {folders.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-border-faint bg-bg-elev/30 px-5 py-6 text-center">
          <div className="flex max-w-[440px] flex-col gap-2 text-text-muted">
            <FolderIcon className="mx-auto text-text-faint" />
            <p className="m-0 text-[14.5px] leading-[1.55]">
              No folders yet. Add the folder where new <code>.jar</code> files land (for example your Minecraft mods folder).
            </p>
            <p className="m-0 text-[13px] text-text-faint">
              Existing files are not re-uploaded.
            </p>
          </div>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {folders.map((f) => (
            <li
              key={f.path}
              className="group flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border border-transparent bg-bg-elev/30 px-3 py-2 transition-[border-color,background] duration-fast ease-out hover:border-border-faint hover:bg-bg-elev/60"
            >
              <FolderIcon className="text-text-muted" />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-text"
                title={f.path}
              >
                {f.path}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <IconButton onClick={() => void scanAll(f.path)} title="Scan all files now">
                  Scan all
                </IconButton>
                <IconButton onClick={() => void watcherShowInFolder(f.path)} title="Reveal in OS file manager">
                  Reveal
                </IconButton>
                <button
                  type="button"
                  onClick={() => void remove(f.path)}
                  title="Remove folder"
                  aria-label="Remove folder"
                  className="inline-flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent bg-transparent text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-sev-critical-edge hover:bg-sev-critical-soft hover:text-sev-critical"
                >
                  <svg width="12" height="12" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <path d="m3 3 7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IconButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="cursor-pointer rounded-[var(--radius-sm)] border border-border-faint bg-bg-plate/60 px-3 py-1.5 text-[12.5px] font-medium text-text-muted transition-[background,border-color,color] duration-fast ease-out hover:border-accent/40 hover:text-accent"
    >
      {children}
    </button>
  );
}
