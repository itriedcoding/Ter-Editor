import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import type { ExtensionTheme } from '../../shared/ipc';
import { labelForLanguage } from '../../shared/languages';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

interface LanguageDefaults {
  setCompilerOptions(options: Record<string, unknown>): void;
  setDiagnosticsOptions(options: Record<string, unknown>): void;
}

interface TsLanguages {
  typescriptDefaults: LanguageDefaults;
  javascriptDefaults: LanguageDefaults;
  ScriptTarget: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
  ModuleKind: { ESNext: number };
  JsxEmit: { ReactJSX: number };
}

// These namespaces exist at runtime because monaco-editor's main entry registers
// the language services; the published types mark them as deprecated.
const tsLanguages = (monaco.languages as unknown as { typescript: TsLanguages }).typescript;
const jsonLanguages = (monaco.languages as unknown as { json: { jsonDefaults: LanguageDefaults } }).json;

tsLanguages.typescriptDefaults.setCompilerOptions({
  target: tsLanguages.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  moduleResolution: tsLanguages.ModuleResolutionKind.NodeJs,
  module: tsLanguages.ModuleKind.ESNext,
  jsx: tsLanguages.JsxEmit.ReactJSX,
  allowJs: true,
  strict: true,
  noEmit: true,
});

tsLanguages.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
});

tsLanguages.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
});

jsonLanguages.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  schemas: [],
  enableSchemaRequest: true,
});

export interface EditorTheme {
  id: string;
  label: string;
  type: 'dark' | 'light' | 'hc';
}

export const BUILTIN_THEMES: EditorTheme[] = [
  { id: 'ter-dark', label: 'Ter Dark', type: 'dark' },
  { id: 'ter-midnight', label: 'Ter Midnight', type: 'dark' },
  { id: 'ter-light', label: 'Ter Light', type: 'light' },
  { id: 'vs-dark', label: 'VS Dark', type: 'dark' },
  { id: 'vs', label: 'VS Light', type: 'light' },
  { id: 'hc-black', label: 'High Contrast', type: 'hc' },
];

const TER_DARK_RULES: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6b7a8f', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c792ea' },
  { token: 'keyword.control', foreground: 'c792ea' },
  { token: 'string', foreground: 'a5d6a7' },
  { token: 'number', foreground: 'ffcb6b' },
  { token: 'regexp', foreground: '89ddff' },
  { token: 'type', foreground: '82aaff' },
  { token: 'type.identifier', foreground: '82aaff' },
  { token: 'identifier', foreground: 'd6deeb' },
  { token: 'delimiter', foreground: '8b98ab' },
  { token: 'tag', foreground: 'f07178' },
  { token: 'attribute.name', foreground: 'ffcb6b' },
  { token: 'attribute.value', foreground: 'a5d6a7' },
  { token: 'metatag', foreground: 'c792ea' },
  { token: 'variable', foreground: 'd6deeb' },
  { token: 'constant', foreground: 'ffcb6b' },
  { token: 'function', foreground: '82aaff' },
  { token: 'entity.name.function', foreground: '82aaff' },
  { token: 'support.function', foreground: '82aaff' },
];

monaco.editor.defineTheme('ter-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: TER_DARK_RULES,
  colors: {
    'editor.background': '#0b0e14',
    'editor.foreground': '#d6deeb',
    'editorLineNumber.foreground': '#3d4759',
    'editorLineNumber.activeForeground': '#9aa7bd',
    'editorCursor.foreground': '#6ea8fe',
    'editor.selectionBackground': '#264468',
    'editor.inactiveSelectionBackground': '#1c2b3f',
    'editor.lineHighlightBackground': '#111725',
    'editorIndentGuide.background1': '#1b2231',
    'editorIndentGuide.activeBackground1': '#2b3purple',
    'editorGutter.background': '#0b0e14',
    'editorWidget.background': '#111725',
    'editorWidget.border': '#1e2736',
    'editorSuggestWidget.background': '#111725',
    'editorSuggestWidget.selectedBackground': '#1b2a3f',
    'editorHoverWidget.background': '#111725',
    'editorHoverWidget.border': '#1e2736',
    'editorBracketMatch.background': '#1b2a3f',
    'editorBracketMatch.border': '#4c7dd8',
    'minimap.background': '#0b0e14',
    'scrollbarSlider.background': '#24304466',
    'scrollbarSlider.hoverBackground': '#2f3d5588',
    'scrollbarSlider.activeBackground': '#3a4a6699',
    'editorError.foreground': '#ff6b6b',
    'editorWarning.foreground': '#ffc857',
    'editorInfo.foreground': '#6ea8fe',
    'editorOverviewRuler.border': '#00000000',
  },
});

monaco.editor.defineTheme('ter-midnight', {
  base: 'vs-dark',
  inherit: true,
  rules: TER_DARK_RULES,
  colors: {
    'editor.background': '#0f1420',
    'editor.foreground': '#e3ecf7',
    'editorLineNumber.foreground': '#48566b',
    'editorLineNumber.activeForeground': '#9fb0c9',
    'editorCursor.foreground': '#7aa2f7',
    'editor.selectionBackground': '#2b3f5e',
    'editor.lineHighlightBackground': '#151c2b',
    'editorGutter.background': '#0f1420',
    'minimap.background': '#0f1420',
  },
});

monaco.editor.defineTheme('ter-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a869a', fontStyle: 'italic' },
    { token: 'keyword', foreground: '8b3dd1' },
    { token: 'string', foreground: '2f7d32' },
    { token: 'number', foreground: 'b26a00' },
    { token: 'type', foreground: '1a5fd0' },
    { token: 'tag', foreground: 'c02f3f' },
    { token: 'attribute.name', foreground: 'b26a00' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f2733',
    'editorLineNumber.foreground': '#b6c0cf',
    'editorLineNumber.activeForeground': '#5b6878',
    'editor.lineHighlightBackground': '#f5f7fa',
    'editor.selectionBackground': '#d7e6ff',
    'editorGutter.background': '#ffffff',
    'minimap.background': '#ffffff',
  },
});

const definedExtensionThemes = new Set<string>();

/** Converts a VS Code color theme document into a Monaco theme. */
export function defineExtensionTheme(theme: ExtensionTheme): void {
  if (definedExtensionThemes.has(theme.id)) return;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) colors[key] = value;
  }
  const rules = theme.rules
    .filter((rule) => Boolean(rule.token))
    .slice(0, 800)
    .map((rule) => ({
      token: rule.token,
      foreground: rule.foreground,
      background: rule.background,
      fontStyle: rule.fontStyle,
    }));
  monaco.editor.defineTheme(theme.id, {
    base: theme.type === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules,
    colors,
  });
  definedExtensionThemes.add(theme.id);
}

export function languageLabel(languageId: string): string {
  return labelForLanguage(languageId);
}

export { monaco };
