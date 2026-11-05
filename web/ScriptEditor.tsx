import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
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
}

const highlighting = HighlightStyle.define([
  { tag: tags.propertyName, color: "#7765a7" },
  { tag: tags.string, color: "#477c8c" },
  { tag: tags.number, color: "#b47b44" },
  { tag: [tags.bool, tags.null], color: "#a46683" },
  { tag: tags.punctuation, color: "#8c98ab" },
]);

export function ScriptEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
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
          syntaxHighlighting(highlighting),
          keymap.of([{ key: "Mod-Enter", run: () => { callbacks.current.onRun(); return true; } }]),
          EditorView.contentAttributes.of({ "aria-label": "Diagram script", spellcheck: "false" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "12.5px", color: "#3d4b60", backgroundColor: "#fff" },
            ".cm-scroller": { overflow: "auto", fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", lineHeight: "1.85" },
            ".cm-content": { padding: "18px 0 80px", caretColor: "#6f65cc" },
            ".cm-line": { padding: "0 22px 0 14px" },
            ".cm-gutters": { backgroundColor: "#fff", color: "#bcc5d2", border: "none", minWidth: "45px" },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", fontSize: "10px" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#f6f7fc" },
            ".cm-foldGutter": { color: "#b6c0ce" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#e8e6fa" },
            "&.cm-focused": { outline: "none" },
            ".cm-tooltip": { border: "1px solid #e4e8f0", borderRadius: "6px", fontFamily: "system-ui", fontSize: "12px" },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  return <div className="script-editor" ref={host} />;
}
