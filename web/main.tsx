import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { layoutDiagram } from "../src/diagram/layout";
import { renderSvg } from "../src/diagram/svg";
import type { IconMap, Scene } from "../src/diagram/types";
import { ScriptEditor } from "./ScriptEditor";
import { Whiteboard } from "./Whiteboard";
import { scriptFor } from "./examples";

interface Rendered { scene: Scene; svg: string }
const measuringContext = document.createElement("canvas").getContext("2d")!;
const iconCache = new Map<string, Promise<string>>();

async function loadIcons(scene: Scene): Promise<IconMap> {
  const aliases = [...new Set(scene.nodes.flatMap((node) => node.icon ? [node.icon] : []))];
  const entries = await Promise.all(aliases.map(async (alias) => {
    if (!/^[a-z0-9-]+$/.test(alias)) throw new Error(`Invalid icon alias “${alias}”. Use a local icon name, for example “redis”.`);
    let pending = iconCache.get(alias);
    if (!pending) {
      pending = fetch(`/icons/${alias}.svg`).then(async (response) => {
        if (!response.ok) throw new Error(`Icon “${alias}” is not available. Fetch it with ./scripts/icons.sh ${alias}, or choose another local icon.`);
        return `data:image/svg+xml,${encodeURIComponent(await response.text())}`;
      }).catch((error) => { iconCache.delete(alias); throw error; });
      iconCache.set(alias, pending);
    }
    return [alias, await pending] as const;
  }));
  return Object.fromEntries(entries);
}

function App() {
  const [source, setSource] = useState(() => scriptFor(0));
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [editorWidth, setEditorWidth] = useState(50);
  const [resizing, setResizing] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const dividerDrag = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const ticket = ++generation.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const input: unknown = JSON.parse(source);
        const scene = await layoutDiagram(input, (text, font) => {
          measuringContext.font = font;
          return measuringContext.measureText(text).width;
        });
        const icons = await loadIcons(scene);
        const svg = renderSvg(scene, icons, { grid: false });
        if (ticket !== generation.current) return;
        setRendered({ scene, svg });
        setError(null);
      } catch (cause) {
        if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (ticket === generation.current) setBusy(false);
      }
    }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [source, revision]);

  const run = useCallback(() => setRevision((value) => value + 1), []);

  return <main
    ref={workspace}
    className={`workspace${resizing ? " is-resizing" : ""}`}
    style={{ gridTemplateColumns: `${editorWidth}% minmax(0, 1fr)` }}
  >
    <section id="script-panel" className="editor-pane" aria-label="Script editor panel" inert={editorWidth === 0} style={{ visibility: editorWidth === 0 ? "hidden" : "visible" }}>
      <ScriptEditor value={source} onChange={setSource} onRun={run} />
      {error && <div className="script-error" role="alert">{error}</div>}
    </section>
    <div
      className="panel-divider"
      role="separator"
      aria-label="Resize script panel"
      aria-orientation="vertical"
      aria-controls="script-panel"
      aria-valuemin={0}
      aria-valuemax={85}
      aria-valuenow={Math.round(editorWidth)}
      tabIndex={0}
      style={{ left: `max(0px, calc(${editorWidth}% - 4px))` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dividerDrag.current = { x: event.clientX, width: editorWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = dividerDrag.current;
        const width = workspace.current?.getBoundingClientRect().width;
        if (!start || !width) return;
        const next = Math.max(0, Math.min(85, start.width + (event.clientX - start.x) / width * 100));
        // Snap the unreadable sliver closed; the divider stays reachable at x=0.
        setEditorWidth(next / 100 * width < 48 ? 0 : next);
      }}
      onPointerUp={() => { dividerDrag.current = null; setResizing(false); }}
      onPointerCancel={() => { dividerDrag.current = null; setResizing(false); }}
      onLostPointerCapture={() => { dividerDrag.current = null; setResizing(false); }}
      onDoubleClick={() => setEditorWidth(50)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setEditorWidth((width) => event.key === "Home" ? 0 : event.key === "End" ? 85 : Math.max(0, Math.min(85, width + (event.key === "ArrowLeft" ? -2 : 2))));
      }}
    />
    <section className="preview-pane" aria-label="Diagram preview panel" aria-busy={busy}>
      <Whiteboard scene={rendered?.scene ?? null} svg={rendered?.svg ?? ""} />
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
