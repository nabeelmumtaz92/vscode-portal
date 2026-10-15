// CodeMirror 6 wrapper used by the phone client (bundled to web/editor.bundle.js by `npm run build`).
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Annotation } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab, undo, redo } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';

const Remote = Annotation.define();

function langFor(p = '') {
  const ext = p.split('.').pop().toLowerCase();
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return javascript({ jsx: true });
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return javascript({ jsx: true, typescript: true });
  if (ext === 'py') return python();
  if (['json', 'jsonc'].includes(ext)) return json();
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return html();
  if (['css', 'scss', 'less'].includes(ext)) return css();
  if (['md', 'mdx', 'markdown'].includes(ext)) return markdown();
  return [];
}

window.PortalEditor = {
  create(parent, onChange) {
    let view;
    const theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: '1.5' },
      '.cm-content': { paddingBottom: '40vh' },
    });
    const makeState = (text, p) => EditorState.create({
      doc: text,
      extensions: [
        basicSetup, keymap.of([indentWithTab]), oneDark, theme, EditorView.lineWrapping, langFor(p),
        EditorView.updateListener.of(u => {
          if (u.docChanged && !u.transactions.some(t => t.annotation(Remote))) onChange(view.state.doc.toString());
        }),
      ],
    });
    view = new EditorView({ parent, state: makeState('', '') });
    return {
      setDoc(text, p) { view.setState(makeState(text, p)); },
      applyRemote(text) {
        const old = view.state.doc.toString();
        if (old === text) return;
        let s = 0;
        const max = Math.min(old.length, text.length);
        while (s < max && old.charCodeAt(s) === text.charCodeAt(s)) s++;
        let eo = old.length, en = text.length;
        while (eo > s && en > s && old.charCodeAt(eo - 1) === text.charCodeAt(en - 1)) { eo--; en--; }
        view.dispatch({ changes: { from: s, to: eo, insert: text.slice(s, en) }, annotations: Remote.of(true) });
      },
      getText: () => view.state.doc.toString(),
      insert(str) { view.dispatch(view.state.replaceSelection(str)); view.focus(); },
      undo() { undo(view); }, redo() { redo(view); },
      focus() { view.focus(); },
      blur() { view.contentDOM.blur(); },
      gotoLine(n) {
        const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
        view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      },
      selection() {
        const r = view.state.selection.main;
        return { line: view.state.doc.lineAt(r.head).number, text: view.state.sliceDoc(r.from, r.to) };
      },
    };
  },
};
