import { useEffect, useRef } from "react";

/**
 * Run `callback` on a fixed interval, but pause the timer while the
 * window is hidden (Dock-minimized, behind another app, OS-hidden).
 * Mirrors the polling pattern in `RemoteStatus` so idle work does not
 * keep ticking when the user cannot see it.
 *
 * The callback is read via a ref so callers can pass an inline arrow
 * (`() => setNow(Date.now())`) without recreating the timer every
 * render.
 */
export function usePausableInterval(callback: () => void, delayMs: number) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    let id: number | null = null;
    const tick = () => saved.current();
    const start = () => {
      if (id !== null) return;
      id = window.setInterval(tick, delayMs);
    };
    const stop = () => {
      if (id !== null) {
        window.clearInterval(id);
        id = null;
      }
    };
    if (document.visibilityState !== "hidden") start();
    const onVis = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [delayMs]);
}
