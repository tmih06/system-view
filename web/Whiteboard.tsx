import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Scene } from "../src/diagram/types";
interface Camera { x: number; y: number; scale: number }
const clampZoom = (value: number) => Math.max(0.04, Math.min(3, value));

interface Props {
  scene: Scene | null;
  svg: string;
  dark: boolean;
  onToggleTheme(): void;
}

export function Whiteboard({ scene, svg, dark, onToggleTheme }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const current = useRef(camera);
  const fittedScene = useRef<Scene | null>(null);
  const drag = useRef<{
    x: number; y: number; camera: Camera;
    lastX: number; lastY: number; time: number; vx: number; vy: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const moveCamera = useCallback((next: Camera) => { current.current = next; setCamera(next); }, []);
  const frame = useRef<number | null>(null);
  const zoomTarget = useRef<Camera | null>(null);
  const velocity = useRef({ x: 0, y: 0 });
  const reducedMotion = useRef(false);

  /** Stop at the currently painted camera, so interrupting never jumps to a target. */
  const stopMotion = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    zoomTarget.current = null;
    velocity.current.x = velocity.current.y = 0;
  }, []);

  /** One frame loop owns eased zoom or inertial pan; speeds are CSS pixels/ms. */
  const animate = useCallback(() => {
    if (frame.current !== null) return;
    let previous = performance.now();
    const tick = (now: number) => {
      frame.current = null;
      // Bound background-tab gaps so resuming cannot fling the camera away.
      const dt = Math.min(32, Math.max(0, now - previous));
      previous = now;
      const old = current.current;
      const target = zoomTarget.current;
      if (target) {
        const ease = 1 - Math.exp(-dt / 75);
        const next = {
          x: old.x + (target.x - old.x) * ease,
          y: old.y + (target.y - old.y) * ease,
          scale: old.scale + (target.scale - old.scale) * ease,
        };
        if (Math.abs(target.x - next.x) < 0.1 && Math.abs(target.y - next.y) < 0.1 && Math.abs(target.scale - next.scale) < 0.0001) {
          zoomTarget.current = null;
          moveCamera(target);
          return;
        }
        moveCamera(next);
      } else {
        const decay = Math.exp(-dt / 260);
        const distance = 260 * (1 - decay);
        moveCamera({ ...old, x: old.x + velocity.current.x * distance, y: old.y + velocity.current.y * distance });
        velocity.current.x *= decay;
        velocity.current.y *= decay;
        if (Math.hypot(velocity.current.x, velocity.current.y) < 0.015) return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [moveCamera]);

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { reducedMotion.current = preference.matches; if (preference.matches) stopMotion(); };
    update();
    preference.addEventListener("change", update);
    return () => { preference.removeEventListener("change", update); stopMotion(); };
  }, [stopMotion]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Ease to a camera target; reduced-motion users jump there immediately. */
  const glideTo = useCallback((target: Camera) => {
    if (reducedMotion.current) {
      stopMotion();
      moveCamera(target);
      return;
    }
    stopMotion();
    zoomTarget.current = target;
    animate();
  }, [animate, moveCamera, stopMotion]);

  const fit = useCallback((animated = true) => {
    if (!scene || !size.width || !size.height) return;
    const scale = clampZoom(Math.min(1.15, (size.width - 48) / scene.width, (size.height - 48) / scene.height));
    const target = { x: (size.width - scene.width * scale) / 2, y: (size.height - scene.height * scale) / 2, scale };
    if (animated) glideTo(target);
    else { stopMotion(); moveCamera(target); }
  }, [scene, size.width, size.height, moveCamera, stopMotion, glideTo]);
  useEffect(() => {
    if (!scene || !size.width || !size.height || fittedScene.current === scene) return;
    // Fit new content once; viewport resizing must preserve the user's camera.
    fittedScene.current = scene;
    fit();
  }, [scene, size.width, size.height, fit]);

  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    if (drag.current) return;
    const old = current.current;
    const scale = clampZoom((zoomTarget.current?.scale ?? old.scale) * factor);
    // Zoom about a fixed viewport point: the diagram point under the pointer stays put.
    glideTo({ x: x - (x - old.x) * scale / old.scale, y: y - (y - old.y) * scale / old.scale, scale });
  }, [glideTo]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.003), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  // Drop every other dot at low zoom instead of packing them into visual noise.
  const dotStep = 24 * camera.scale;
  const dotSpacing = dotStep * 2 ** Math.max(0, Math.ceil(Math.log2(20 / dotStep)));

  return <div className="whiteboard-shell">
    <div
      ref={viewport}
      className={`whiteboard${dragging ? " is-dragging" : ""}`}
      role="region"
      aria-label="Diagram canvas"
      data-zoom={camera.scale.toFixed(3)}
      style={{
        backgroundPosition: `${camera.x}px ${camera.y}px`,
        backgroundSize: `${dotSpacing}px ${dotSpacing}px`,
      }}
      onDoubleClick={() => fit()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        stopMotion();
        drag.current = {
          x: event.clientX, y: event.clientY, camera: current.current,
          lastX: event.clientX, lastY: event.clientY, time: event.timeStamp, vx: 0, vy: 0,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const dt = Math.max(1, event.timeStamp - start.time);
        // Filter pointer-event noise and cap launch speed at 3 CSS pixels/ms.
        start.vx = Math.max(-3, Math.min(3, 0.6 * (event.clientX - start.lastX) / dt + 0.4 * start.vx));
        start.vy = Math.max(-3, Math.min(3, 0.6 * (event.clientY - start.lastY) / dt + 0.4 * start.vy));
        start.lastX = event.clientX;
        start.lastY = event.clientY;
        start.time = event.timeStamp;
        moveCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y });
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        setDragging(false);
        // Holding still before release is a deliberate stop, not a fling.
        if (!start || reducedMotion.current || event.timeStamp - start.time > 80) return;
        velocity.current.x = start.vx;
        velocity.current.y = start.vy;
        if (Math.hypot(start.vx, start.vy) >= 0.015) animate();
      }}
      onPointerCancel={() => { drag.current = null; setDragging(false); stopMotion(); }}
      onLostPointerCapture={() => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        stopMotion();
      }}
    >
      {scene ? <div
        className="diagram-content"
        style={{ width: scene.width, height: scene.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      /> : null}
    </div>
    <div className="view-tools" role="group" aria-label="View controls">
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!scene || camera.scale <= 0.04} onClick={() => zoomAt(1 / 1.35, size.width / 2, size.height / 2)}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!scene || camera.scale >= 3} onClick={() => zoomAt(1.35, size.width / 2, size.height / 2)}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14M12 5v14" /></svg>
      </button>
      <button type="button" aria-label="Fit view" title="Fit view" disabled={!scene} onClick={() => fit()}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></svg>
      </button>
      <button type="button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"} aria-pressed={dark} onClick={onToggleTheme}>
        {dark
          ? <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" /></svg>
          : <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>}
      </button>
    </div>
  </div>;
}
