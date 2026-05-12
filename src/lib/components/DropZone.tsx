import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { cn } from "../cn";

interface Props {
  onPick: (path: string) => void;
}

const SUPPORTED_EXTS = ["jar", "zip", "mcpack", "mrpack"] as const;

function hasSupportedExt(path: string): boolean {
  const lower = path.toLowerCase();
  return SUPPORTED_EXTS.some((e) => lower.endsWith(`.${e}`));
}

// IMPORTANT: native file drops in Tauri arrive via getCurrentWebview().onDragDropEvent.
// HTML5 onDragOver/onDrop will NOT receive the file path on macOS or Windows.
// Do not "simplify" this to JSX drag handlers.
export default function DropZone({ onPick }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [picking, setPicking] = useState(false);

  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") setDragOver(true);
        else if (event.payload.type === "leave") setDragOver(false);
        else if (event.payload.type === "drop") {
          setDragOver(false);
          const picked =
            event.payload.paths.find(hasSupportedExt) ??
            event.payload.paths[0];
          if (picked) onPickRef.current(picked);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    const onBlur = () => setDragOver(false);
    window.addEventListener("blur", onBlur);

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  async function pickFile() {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "JAR or container", extensions: [...SUPPORTED_EXTS] },
        ],
      });
      if (typeof selected === "string") onPick(selected);
    } catch (e) {
      console.error("[DropZone] open dialog failed", e);
    } finally {
      setPicking(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void pickFile();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Choose a .jar, .zip, .mcpack, or .mrpack file to scan, or drop one onto this area"
      aria-disabled={picking || undefined}
      onClick={pickFile}
      onKeyDown={onKeyDown}
      className={cn(
        "frame group relative isolate flex h-full min-h-[420px] w-full cursor-pointer flex-col items-center justify-center gap-6 overflow-hidden px-10 py-16 text-center transition-colors duration-base ease-out",
        dragOver
          ? "bg-bg-elev"
          : "hover:bg-bg-elev/40",
        picking && "cursor-wait opacity-90",
      )}
    >
      <div
        className={cn(
          "relative inline-flex h-14 w-14 items-center justify-center rounded-[var(--radius-sm)] border bg-bg-elev transition-[transform,border-color,color] duration-base ease-out will-change-transform",
          dragOver
            ? "border-text text-text [transform:scale(1.05)_translateZ(0)]"
            : "border-border-faint text-text-muted group-hover:border-border group-hover:text-text",
        )}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 18.5h14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.55"
          />
        </svg>
      </div>

      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-text">
          {dragOver ? "Release to scan" : "Drop a file to scan"}
        </h2>
        <p className="m-0 text-[14.5px] text-text-muted">
          .jar, .zip, .mcpack, or .mrpack. Up to 50 MB.
        </p>
      </div>

      <span
        aria-hidden="true"
        className="relative inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-status-ok px-5 py-2.5 text-[14px] font-semibold tracking-[-0.005em] text-bg shadow-[0_0_0_1px_var(--color-status-ok-edge)] transition-[background,box-shadow,transform] duration-fast ease-out group-hover:bg-status-ok-bright group-hover:shadow-[0_0_0_4px_var(--color-status-ok-soft)] group-active:translate-y-[1px]"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2 9.5V4A1.5 1.5 0 0 1 3.5 2.5h3l1.5 1.5h3A1.5 1.5 0 0 1 12.5 5.5v4A1.5 1.5 0 0 1 11 11H3.5A1.5 1.5 0 0 1 2 9.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        Choose file
      </span>
    </div>
  );
}
