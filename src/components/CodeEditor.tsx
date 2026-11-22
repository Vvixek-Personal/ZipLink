import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { tags } from '@lezer/highlight';
import type { CodeLanguageId } from '../shared/language.ts';

export interface CodeEditorHandle {
  undo: () => boolean;
  redo: () => boolean;
  focus: () => void;
}

interface CodeEditorProps {
  docKey: string;
  value: string;
  languageId: CodeLanguageId;
  readOnly: boolean;
  wordWrap: boolean;
  effectiveTheme: 'light' | 'dark';
  ariaLabel: string;
  onChange?: (nextValue: string) => void;
  onSaveShortcut?: () => void;
  onHistoryStateChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
}

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c3aed', fontWeight: '600' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#0f172a' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#1d4ed8' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#0369a1' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#0f172a' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#b45309' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#0e7490' },
  { tag: [tags.meta, tags.comment], color: '#64748b', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#1d4ed8', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: '700', color: '#0f172a' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#b91c1c' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#15803d' },
  { tag: tags.propertyName, color: '#0369a1' },
  { tag: tags.tagName, color: '#be123c' },
  { tag: tags.attributeName, color: '#b45309' },
  { tag: tags.invalid, color: '#dc2626', textDecoration: 'underline' },
]);

const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c4b5fd', fontWeight: '600' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#e2e8f0' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#93c5fd' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#7dd3fc' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#e2e8f0' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#fcd34d' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#67e8f9' },
  { tag: [tags.meta, tags.comment], color: '#94a3b8', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#93c5fd', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: '700', color: '#f8fafc' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#fca5a5' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#86efac' },
  { tag: tags.propertyName, color: '#7dd3fc' },
  { tag: tags.tagName, color: '#fda4af' },
  { tag: tags.attributeName, color: '#fcd34d' },
  { tag: tags.invalid, color: '#f87171', textDecoration: 'underline' },
]);

function buildEditorTheme(mode: 'light' | 'dark'): Extension {
  const isDark = mode === 'dark';
  const baseTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: isDark ? '#0f172a' : '#ffffff',
        color: isDark ? '#e2e8f0' : '#0f172a',
        fontSize: '13px',
        lineHeight: '1.6',
        fontFamily: 'var(--font-mono)',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        overflow: 'auto',
        minHeight: '380px',
        maxHeight: '640px',
      },
      '.cm-content': {
        padding: '12px 0',
        caretColor: isDark ? '#60a5fa' : '#1d4ed8',
      },
      '.cm-line': {
        padding: '0 16px 0 12px',
      },
      '.cm-gutters': {
        backgroundColor: isDark ? '#0b1120' : '#f8fafc',
        color: isDark ? '#64748b' : '#64748b',
        borderRight: isDark ? '1px solid #1e293b' : '1px solid #e2e8f0',
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 12px 0 10px',
        minWidth: '44px',
        fontVariantNumeric: 'tabular-nums',
      },
      '.cm-activeLine': {
        backgroundColor: isDark ? 'rgba(51, 65, 85, 0.35)' : 'rgba(226, 232, 240, 0.45)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: isDark ? '#1e293b' : '#f1f5f9',
        color: isDark ? '#cbd5e1' : '#334155',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: isDark ? 'rgba(59, 130, 246, 0.35) !important' : 'rgba(191, 219, 254, 0.85) !important',
      },
      '.cm-cursor': {
        borderLeftColor: isDark ? '#60a5fa' : '#1d4ed8',
        borderLeftWidth: '2px',
      },
      '.cm-matchingBracket': {
        backgroundColor: isDark ? 'rgba(59, 130, 246, 0.25)' : 'rgba(59, 130, 246, 0.15)',
        outline: isDark ? '1px solid #60a5fa' : '1px solid #2563eb',
      },
    },
    { dark: isDark },
  );

  return [
    baseTheme,
    syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle),
  ];
}

function getLanguageExtension(languageId: CodeLanguageId): Extension {
  switch (languageId) {
    case 'javascript':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'html':
      return html();
    case 'css':
    case 'scss':
      return css();
    case 'python':
      return python();
    case 'markdown':
      return markdown();
    case 'yaml':
      return yaml();
    case 'xml':
    case 'svg':
      return xml();
    case 'shell':
      return StreamLanguage.define(shell);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'sql':
      return StreamLanguage.define(standardSQL);
    case 'plaintext':
    default:
      return [];
  }
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  (
    {
      docKey,
      value,
      languageId,
      readOnly,
      wordWrap,
      effectiveTheme,
      ariaLabel,
      onChange,
      onSaveShortcut,
      onHistoryStateChange,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSaveShortcut);
    const onHistoryRef = useRef(onHistoryStateChange);
    onChangeRef.current = onChange;
    onSaveRef.current = onSaveShortcut;
    onHistoryRef.current = onHistoryStateChange;

    const compartmentsRef = useRef({
      language: new Compartment(),
      theme: new Compartment(),
      readOnly: new Compartment(),
      wrap: new Compartment(),
      accessibility: new Compartment(),
    });

    const lastDocKeyRef = useRef<string>(docKey);

    const createEditorState = (docText: string): EditorState => {
      const c = compartmentsRef.current;
      return EditorState.create({
        doc: docText,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          history(),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          c.language.of(getLanguageExtension(languageId)),
          c.theme.of(buildEditorTheme(effectiveTheme)),
          c.readOnly.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          c.wrap.of(wordWrap ? EditorView.lineWrapping : []),
          c.accessibility.of(
            EditorView.contentAttributes.of({
              'aria-label': ariaLabel,
              'aria-readonly': readOnly ? 'true' : 'false',
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const nextDoc = update.state.doc.toString();
              onChangeRef.current?.(nextDoc);
              onHistoryRef.current?.({
                canUndo: undoDepth(update.state) > 0,
                canRedo: redoDepth(update.state) > 0,
              });
            }
          }),
        ],
      });
    };

    useImperativeHandle(ref, () => ({
      undo: () => {
        const view = viewRef.current;
        if (!view) return false;
        return undo(view);
      },
      redo: () => {
        const view = viewRef.current;
        if (!view) return false;
        return redo(view);
      },
      focus: () => {
        viewRef.current?.focus();
      },
    }));

    // Mount CodeMirror once
    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) return;

      const view = new EditorView({
        state: createEditorState(value),
        parent,
      });
      viewRef.current = view;
      lastDocKeyRef.current = docKey;
      onHistoryRef.current?.({ canUndo: false, canRedo: false });

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reset state cleanly when switching files or explicitly resetting buffer (docKey changes)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (lastDocKeyRef.current !== docKey) {
        lastDocKeyRef.current = docKey;
        view.setState(createEditorState(value));
        onHistoryRef.current?.({ canUndo: false, canRedo: false });
      } else {
        const currentDoc = view.state.doc.toString();
        if (currentDoc !== value) {
          view.dispatch({
            changes: { from: 0, to: currentDoc.length, insert: value },
          });
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey, value]);

    // Reconfigure language dynamically
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: compartmentsRef.current.language.reconfigure(getLanguageExtension(languageId)),
      });
    }, [languageId]);

    // Reconfigure theme dynamically
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: compartmentsRef.current.theme.reconfigure(buildEditorTheme(effectiveTheme)),
      });
    }, [effectiveTheme]);

    // Reconfigure readOnly & accessibility dynamically
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: [
          compartmentsRef.current.readOnly.reconfigure([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          compartmentsRef.current.accessibility.reconfigure(
            EditorView.contentAttributes.of({
              'aria-label': ariaLabel,
              'aria-readonly': readOnly ? 'true' : 'false',
            }),
          ),
        ],
      });
    }, [readOnly, ariaLabel]);

    // Reconfigure line wrapping dynamically
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: compartmentsRef.current.wrap.reconfigure(
          wordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [wordWrap]);

    return (
      <div
        ref={containerRef}
        data-testid="codemirror-container"
        data-language={languageId}
        data-readonly={readOnly ? 'true' : 'false'}
        data-theme={effectiveTheme}
        className="w-full overflow-hidden"
      />
    );
  },
);

CodeEditor.displayName = 'CodeEditor';
