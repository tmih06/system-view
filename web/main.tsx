import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { layoutDiagram } from "../src/diagram/layout";
import { themes, type ThemeName } from "../src/diagram/theme";
import { renderSvg } from "../src/diagram/svg";
import type { IconMap, Scene } from "../src/diagram/types";
import { ScriptEditor } from "./ScriptEditor";
import { Whiteboard } from "./Whiteboard";
import { scriptFor } from "./examples";

/** Layout output, independent of paint: a theme change must not re-run ELK. */
interface LaidOut { scene: Scene; icons: IconMap }
const WIDTH_KEY = "system-view:script-panel-width";
const THEME_KEY = "system-view:theme";

/** Stored palette, else the OS preference; unknown values fall back to light. */
function readStoredTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch { /* storage disabled */ }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Restore the last split; ignore missing, corrupt, or out-of-range values. */
function readStoredWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= 85 ? stored : 50;
  } catch {
    return 50;
  }
}

// Kept off the critical path: feedback tooling must not delay the first diagram paint.
const Agentation = lazy(() => import("agentation").then((module) => ({ default: module.Agentation })));
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
  const [laidOut, setLaidOut] = useState<LaidOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [editorWidth, setEditorWidth] = useState(readStoredWidth);
  const [themeName, setThemeName] = useState<ThemeName>(readStoredTheme);
  const [resizing, setResizing] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const dividerDrag = useRef<{ x: number; width: number } | null>(null);

  // Debounce during drag so the width is stored once per settle, not per pointer event.
  useEffect(() => {
    if (resizing) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(WIDTH_KEY, String(editorWidth)); } catch { /* storage disabled */ }
    }, 150);
    return () => clearTimeout(timer);
  }, [editorWidth, resizing]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeName;
    try { localStorage.setItem(THEME_KEY, themeName); } catch { /* storage disabled */ }
  }, [themeName]);

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
        if (ticket !== generation.current) return;
        setLaidOut({ scene, icons });
        setError(null);
      } catch (cause) {
        if (ticket === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (ticket === generation.current) setBusy(false);
      }
    }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [source, revision]);

  // Repaint only: the palette is not an input to layout, so switching themes is
  // a synchronous re-render of the same scene with no ELK run, delay, or re-fit.
  const svg = useMemo(
    () => laidOut ? renderSvg(laidOut.scene, laidOut.icons, { grid: false, palette: themes[themeName] }) : "",
    [laidOut, themeName],
  );

  const run = useCallback(() => setRevision((value) => value + 1), []);

  return <>
    <main
      ref={workspace}
      className={`workspace${resizing ? " is-resizing" : ""}`}
      style={{ gridTemplateColumns: `${editorWidth}% minmax(0, 1fr)` }}
    >
    <section id="script-panel" className="editor-pane" aria-label="Script editor panel" inert={editorWidth === 0} style={{ visibility: editorWidth === 0 ? "hidden" : "visible" }}>
      <ScriptEditor value={source} onChange={setSource} onRun={run} dark={themeName === "dark"} />
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
        setEditorWidth(next);
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
    >
      {/* A real element, not a pseudo-element: it can be measured and centred. */}
      <span className="panel-divider-pill" aria-hidden="true" />
    </div>
    <section className="preview-pane" aria-label="Diagram preview panel" aria-busy={busy}>
      <Whiteboard
        scene={laidOut?.scene ?? null}
        svg={svg}
        dark={themeName === "dark"}
        onToggleTheme={() => setThemeName((name) => name === "dark" ? "light" : "dark")}
      />
    </section>
    </main>
    <Suspense fallback={null}><Agentation /></Suspense>
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
