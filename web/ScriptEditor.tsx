import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

interface Props {
  value: string;
  onChange(value: string): void;
  onRun(): void;
  dark: boolean;
}

const palettes = {
  light: {
    text: "#3d4b60",
    background: "#fff",
    caret: "#6f65cc",
    gutter: "#bcc5d2",
    active: "#f6f7fc",
    selection: "#e8e6fa",
    tooltipBorder: "#e4e8f0",
    tags: { propertyName: "#7765a7", string: "#477c8c", number: "#b47b44", bool: "#a46683", punctuation: "#8c98ab" },
  },
  dark: {
    text: "#c6d2df",
    background: "#12161c",
    caret: "#8fb6e6",
    gutter: "#4b5764",
    active: "#1a2027",
    selection: "#2b3a4c",
    tooltipBorder: "#2c343e",
    tags: { propertyName: "#a99ad8", string: "#7fb3a8", number: "#d3a678", bool: "#cd92ae", punctuation: "#7d8a99" },
  },
} as const;

/** Editor chrome and syntax paint, rebuilt when the palette changes. */
function editorTheme(dark: boolean) {
  const palette = dark ? palettes.dark : palettes.light;
  return [
    EditorView.theme({
      "&": { height: "100%", fontSize: "12.5px", color: palette.text, backgroundColor: palette.background },
      ".cm-scroller": { overflow: "auto", fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", lineHeight: "1.85" },
      ".cm-content": { padding: "18px 0 80px", caretColor: palette.caret },
      ".cm-line": { padding: "0 22px 0 14px" },
      ".cm-gutters": { backgroundColor: palette.background, color: palette.gutter, border: "none", minWidth: "45px" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", fontSize: "10px" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: palette.active },
      ".cm-foldGutter": { color: palette.gutter },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: palette.selection },
      "&.cm-focused": { outline: "none" },
      ".cm-tooltip": { border: `1px solid ${palette.tooltipBorder}`, borderRadius: "6px", fontFamily: "system-ui", fontSize: "12px", backgroundColor: palette.background, color: palette.text },
    }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: tags.propertyName, color: palette.tags.propertyName },
      { tag: tags.string, color: palette.tags.string },
      { tag: tags.number, color: palette.tags.number },
      { tag: [tags.bool, tags.null], color: palette.tags.bool },
      { tag: tags.punctuation, color: palette.tags.punctuation },
    ])),
  ];
}

export function ScriptEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const paint = useRef(new Compartment());
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: callbacks.current.value,
        extensions: [
          basicSetup,
          json(),
          linter(jsonParseLinter()),
          EditorState.tabSize.of(2),
          paint.current.of(editorTheme(callbacks.current.dark)),
          keymap.of([{ key: "Mod-Enter", run: () => { callbacks.current.onRun(); return true; } }]),
          EditorView.contentAttributes.of({ "aria-label": "Diagram script", spellcheck: "false" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);

  // Reconfigure paint only: rebuilding the view would discard undo history.
  useEffect(() => {
    editor.current?.dispatch({ effects: paint.current.reconfigure(editorTheme(props.dark)) });
  }, [props.dark]);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  return <div className="script-editor" ref={host} />;
}
