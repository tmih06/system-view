import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Scene } from "../src/diagram/types";
interface Camera { x: number; y: number; scale: number }
const clampZoom = (value: number) => Math.max(0.04, Math.min(3, value));

export function Whiteboard({ scene, svg }: { scene: Scene | null; svg: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const current = useRef(camera);
  const drag = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const [dragging, setDragging] = useState(false);
  const moveCamera = useCallback((next: Camera) => { current.current = next; setCamera(next); }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (!scene || !size.width || !size.height) return;
    const scale = clampZoom(Math.min(1.15, (size.width - 48) / scene.width, (size.height - 48) / scene.height));
    moveCamera({ x: (size.width - scene.width * scale) / 2, y: (size.height - scene.height * scale) / 2, scale });
  }, [scene, size.width, size.height, moveCamera]);
  useEffect(fit, [fit]);

  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    const old = current.current;
    const scale = clampZoom(old.scale * factor);
    moveCamera({ x: x - (x - old.x) * scale / old.scale, y: y - (y - old.y) * scale / old.scale, scale });
  }, [moveCamera]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
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
      onDoubleClick={fit}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { x: event.clientX, y: event.clientY, camera: current.current };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start) moveCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y });
      }}
      onPointerUp={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    >
      {scene ? <div
        className="diagram-content"
        style={{ width: scene.width, height: scene.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      /> : null}
    </div>
  </div>;
}
