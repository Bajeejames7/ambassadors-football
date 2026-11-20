import { useEffect, useRef, type ReactNode } from "react";
import "../parent3d.css";

const TILTABLE = ".sheet, .slab, .fixture";
const MAX_TILT = 6; // degrees

/**
 * Wraps the parent screens in the 3D theme and tilts whichever card is under
 * the pointer toward it. One delegated listener for the whole page; only on
 * devices with a real hover pointer, never when reduced motion is requested.
 */
export function Parent3D({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let active: HTMLElement | null = null;
    let frame = 0;

    const reset = (card: HTMLElement | null) => {
      if (!card) return;
      card.classList.remove("is-tilting");
      card.style.removeProperty("--rx");
      card.style.removeProperty("--ry");
    };

    const onMove = (e: PointerEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(TILTABLE);
      if (card !== active) {
        reset(active);
        active = card && el.contains(card) ? card : null;
      }
      if (!active) return;
      cancelAnimationFrame(frame);
      const target = active;
      frame = requestAnimationFrame(() => {
        const r = target.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width; // 0..1
        const y = (e.clientY - r.top) / r.height;
        // Large cards tilt less, so long lists don't swing about.
        const scale = Math.min(1, 320 / Math.max(r.height, 1));
        target.style.setProperty("--ry", `${((x - 0.5) * 2 * MAX_TILT * scale).toFixed(2)}deg`);
        target.style.setProperty("--rx", `${((0.5 - y) * 2 * MAX_TILT * scale).toFixed(2)}deg`);
        target.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        target.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
        target.classList.add("is-tilting");
      });
    };
    const onLeave = () => {
      reset(active);
      active = null;
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <div ref={root} className="parent-3d">{children}</div>;
}
