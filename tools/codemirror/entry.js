// Fuente del bundle del editor (CodeMirror 6) que usa el IDE de OrgGadget.
// Se compila a lib/vendor/codemirror.js con build.mjs (ver README).
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  bracketMatching,
  foldKeymap,
  StreamLanguage,
  HighlightStyle,
  indentUnit,
} from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { clike } from "@codemirror/legacy-modes/mode/clike";

// ───────────────────────────────────────── Apex (sin distinguir mayúsculas, como el lenguaje)
const caseInsensitive = (words) => {
  const set = new Set(words.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()));
  return new Proxy(
    {},
    {
      getOwnPropertyDescriptor: (_, k) =>
        typeof k === "string" && set.has(k.toLowerCase()) ? { value: true, enumerable: true, configurable: true } : undefined,
    }
  );
};

const apex = StreamLanguage.define(
  clike({
    name: "apex",
    keywords: caseInsensitive(
      "abstract after before break catch class continue default delete do else enum extends final finally for global if implements " +
        "inherited insert instanceof interface merge new override private protected public return sharing static super switch testmethod " +
        "this throw transient trigger try undelete update upsert virtual webservice when while with without on " +
        "select from where and or not in like includes excludes order by asc desc nulls first last limit offset group having " +
        "typeof then end all rows security_enforced user_mode system_mode as"
    ),
    types: caseInsensitive(
      "blob boolean date datetime decimal double id integer long object string time list map set sobject void exception " +
        "database schema system"
    ),
    builtin: caseInsensitive("test limits userinfo json math apexpages label trigger messaging http httprequest httpresponse eventbus"),
    atoms: caseInsensitive("true false null"),
    blockKeywords: caseInsensitive("catch class do else finally for if switch try while"),
    defKeywords: caseInsensitive("class interface enum trigger"),
    typeFirstDefinitions: true,
    indentStatements: false,
    hooks: {
      "@": (stream) => {
        stream.eatWhile(/[\w$_]/);
        return "meta";
      },
    },
  })
);

const LANGS = {
  apex: () => apex,
  javascript: () => javascript(),
  html: () => html(),
  css: () => css(),
  xml: () => xml(),
};

// ───────────────────────────────────────── Colores de OrgGadget
const orgLensHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: "#c084fc", fontWeight: "600" },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: "#86efac" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fbbf24" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#64748b", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "#67e8f9" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#93c5fd" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#f1f5f9", fontWeight: "600" },
  { tag: t.propertyName, color: "#a5b4fc" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket], color: "#7dd3fc" },
  { tag: t.tagName, color: "#f472b6" },
  { tag: t.attributeName, color: "#fbbf24" },
  { tag: [t.meta, t.annotation], color: "#f9a8d4" },
  { tag: t.variableName, color: "#e2e8f0" },
  { tag: t.invalid, color: "#f87171" },
]);

const orgLensTheme = EditorView.theme(
  {
    "&": { color: "#e2e8f0", backgroundColor: "#0b1020", height: "100%", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "var(--mono, Consolas, monospace)", lineHeight: "1.65", fontVariantLigatures: "none" },
    ".cm-content": { caretColor: "#e0e7ff", padding: "12px 0" },
    ".cm-gutters": { backgroundColor: "#0b1020", color: "#475569", border: "none", borderRight: "1px solid rgba(148,163,184,.12)" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
    ".cm-activeLine": { backgroundColor: "rgba(129,140,248,.08)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(129,140,248,.14)", color: "#c7d2fe" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#e0e7ff", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(129,140,248,.32) !important",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "rgba(192,132,252,.22)", outline: "1px solid rgba(192,132,252,.6)" },
    ".cm-searchMatch": { backgroundColor: "rgba(251,191,36,.22)", outline: "1px solid rgba(251,191,36,.45)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(251,191,36,.45)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(129,140,248,.18)" },
    ".cm-foldPlaceholder": { backgroundColor: "rgba(129,140,248,.2)", border: "none", color: "#c7d2fe", padding: "0 6px", borderRadius: "4px" },
    ".cm-foldGutter .cm-gutterElement": { color: "#64748b", cursor: "pointer" },
    ".cm-tooltip": { backgroundColor: "#141a31", border: "1px solid rgba(148,163,184,.22)", borderRadius: "10px", color: "#e2e8f0", overflow: "hidden" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px !important" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "rgba(129,140,248,.35)", color: "#fff" },
    ".cm-completionIcon": { color: "#a5b4fc" },
    ".cm-panels": { backgroundColor: "#141a31", color: "#e2e8f0", borderColor: "rgba(148,163,184,.2) !important" },
    ".cm-panels input": { backgroundColor: "#0b1020", color: "#e2e8f0", border: "1px solid rgba(148,163,184,.3)", borderRadius: "6px", padding: "3px 6px" },
    ".cm-panels button": { backgroundImage: "none", backgroundColor: "rgba(129,140,248,.2)", color: "#e0e7ff", border: "none", borderRadius: "6px", padding: "3px 8px" },
    ".cm-panels label": { color: "#94a3b8" },
    ".cm-lintRange-error": {
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='%23f87171' fill='none' stroke-width='1.1'/%3E%3C/svg%3E\")",
    },
    ".cm-diagnostic": { padding: "6px 10px" },
    ".cm-diagnostic-error": { borderLeft: "3px solid #ef4444" },
    ".cm-lint-marker-error": { content: "none" },
    ".cm-gutter-lint": { width: "1.1em" },
  },
  { dark: true }
);

// ───────────────────────────────────────── API pública
/**
 * Crea un editor. Cada archivo usa su propio EditorState (con su historial de deshacer);
 * cambiar de archivo = view.setState(state).
 */
export function createIde(parent, { onChange, onSave, onCursor } = {}) {
  const readOnlyConf = new Compartment();
  const listener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onChange?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) {
      const pos = u.state.selection.main.head;
      const line = u.state.doc.lineAt(pos);
      onCursor?.(line.number, pos - line.from + 1);
    }
  });
  const saveKeys = keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSave?.();
        return true;
      },
    },
  ]);

  const makeState = (doc, lang, readOnly = false) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter({ openText: "▾", closedText: "▸" }),
        lintGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of("    "),
        syntaxHighlighting(orgLensHighlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        saveKeys,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        (LANGS[lang] || LANGS.javascript)(),
        orgLensTheme,
        readOnlyConf.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        listener,
      ],
    });

  const view = new EditorView({ parent, state: makeState("", "javascript") });

  return {
    view,
    makeState,
    setState: (state) => view.setState(state),
    getState: () => view.state,
    getDoc: () => view.state.doc.toString(),
    focus: () => view.focus(),
    /** errors: [{ line, column, message }] (1-based) */
    setErrors(errors) {
      const doc = view.state.doc;
      const diagnostics = errors
        .filter((e) => e.line)
        .map((e) => {
          const line = doc.line(Math.min(Math.max(1, e.line), doc.lines));
          const from = Math.min(line.to, line.from + Math.max(0, (e.column || 1) - 1));
          return { from, to: Math.max(from + 1, line.to) > doc.length ? doc.length : Math.max(from + 1, line.to), severity: "error", message: e.message };
        });
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
    goto(line, column = 1) {
      const doc = view.state.doc;
      const l = doc.line(Math.min(Math.max(1, line), doc.lines));
      const pos = Math.min(l.to, l.from + Math.max(0, column - 1));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
