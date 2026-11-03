/**
 * The `vscode` module implementation given to extensions.
 *
 * This follows the real VS Code extension API surface for the features Ter Editor
 * supports: commands, documents, editors, diagnostics, status bar, output,
 * configuration, workspace files, file watchers, themes, snippets and state.
 *
 * Deliberately unsupported (calls log a clear warning instead of pretending to
 * work): webview panels, terminals, language-server style completion/hover/
 * formatting providers, and debug adapters.
 */
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DiagnosticItem, ExtensionInfo, StatusItem, ThemeRule } from '../../shared/ipc';
import { fileUri, uriToPath } from '../../shared/uri';
import { languageForPath, labelForLanguage, EXTRA_LANGUAGES } from '../../shared/languages';
import type { DocState, ExtensionHost } from './host';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;

  constructor(scheme: string, authority: string, uriPath: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = uriPath;
    this.query = query;
    this.fragment = fragment;
  }

  static file(fsPath: string): Uri {
    return Uri.parse(fileUri(fsPath));
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!match) {
      if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) return Uri.file(value);
      throw new Error(`Cannot parse URI: ${value}`);
    }
    const [, scheme, authority, uriPath, query, fragment] = match;
    return new Uri(scheme, authority, decodeURIComponent(uriPath), query ? decodeURIComponent(query) : '', fragment ? decodeURIComponent(fragment) : '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = path.posix.join(base.path, ...segments.map((segment) => segment.replace(/\\/g, '/')));
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }

  static isUri(value: Any): value is Uri {
    return value instanceof Uri;
  }

  get fsPath(): string {
    if (this.scheme !== 'file') return this.path;
    return uriToPath(this.toString());
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    const authority = this.authority ? this.authority : '';
    const encodedPath = this.path
      .split('/')
      .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
      .join('/');
    const prefix = this.scheme === 'file' ? 'file://' : `${this.scheme}://${authority}`;
    return `${prefix}${encodedPath}${this.query ? `?${encodeURIComponent(this.query)}` : ''}${this.fragment ? `#${encodeURIComponent(this.fragment)}` : ''}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

class Position {
  line: number;
  character: number;
  constructor(line: number, character: number) {
    this.line = Math.max(0, line);
    this.character = Math.max(0, character);
  }
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: Position): boolean {
    return !other.isBefore(this);
  }
  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }
  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  compareTo(other: Position): number {
    if (this.line !== other.line) return this.line - other.line;
    return this.character - other.character;
  }
  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

class Range {
  start: Position;
  end: Position;
  constructor(startLineOrStart: number | Position, startCharacterOrEnd?: number | Position, endLine?: number, endCharacter?: number) {
    if (startLineOrStart instanceof Position && startCharacterOrEnd instanceof Position) {
      this.start = startLineOrStart;
      this.end = startCharacterOrEnd;
    } else {
      const sl = startLineOrStart as number;
      const sc = startCharacterOrEnd as number;
      const el = endLine ?? sl;
      const ec = endCharacter ?? sc;
      const start = new Position(sl, sc);
      const end = new Position(el, ec);
      if (start.isAfter(end)) {
        this.start = end;
        this.end = start;
      } else {
        this.start = start;
        this.end = end;
      }
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(positionOrRange: Position | Range): boolean {
    const range = positionOrRange instanceof Range ? positionOrRange : new Range(positionOrRange, positionOrRange);
    return !range.start.isBefore(this.start) && !range.end.isAfter(this.end);
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }
  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }
  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

class Selection extends Range {
  anchor: Position;
  active: Position;
  constructor(anchorLine: number | Position, anchorCharacterOrActive?: number | Position, activeLine?: number, activeCharacter?: number) {
    if (anchorLine instanceof Position && anchorCharacterOrActive instanceof Position) {
      super(anchorLine, anchorCharacterOrActive);
      this.anchor = anchorLine;
      this.active = anchorCharacterOrActive;
    } else {
      const al = anchorLine as number;
      const ac = anchorCharacterOrActive as number;
      super(al, ac, activeLine ?? al, activeCharacter ?? ac);
      this.anchor = new Position(al, ac);
      this.active = new Position(activeLine ?? al, activeCharacter ?? ac);
    }
  }
  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

class Location {
  uri: Uri;
  range: Range;
  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
  }
}

class Diagnostic {
  range: Range;
  message: string;
  severity: number;
  source?: string;
  code?: string | number;
  relatedInformation?: Any[];
  constructor(range: Range, message: string, severity: number = 0) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class TextEdit {
  range: Range;
  newText: string;
  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
  static setEndOfLine(): TextEdit {
    return new TextEdit(new Range(0, 0, 0, 0), '');
  }
}

class WorkspaceEdit {
  private fileEdits: Array<{ uri: string; edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> }> = [];
  private fileOperations: Array<{ kind: 'create' | 'delete' | 'rename'; uri: string; target?: string; ignoreIfExists?: boolean; recursive?: boolean }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this.fileEdits.push({
      uri: uri.toString(),
      edits: [
        {
          startLine: range.start.line + 1,
          startColumn: range.start.character + 1,
          endLine: range.end.line + 1,
          endColumn: range.end.character + 1,
          newText,
        },
      ],
    });
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText);
  }
  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, '');
  }
  set(uri: Uri, edits: TextEdit[]): void {
    this.fileEdits.push({
      uri: uri.toString(),
      edits: edits.map((edit) => ({
        startLine: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLine: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1,
        newText: edit.newText,
      })),
    });
  }
  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this.fileOperations.push({ kind: 'create', uri: uri.toString(), ignoreIfExists: options?.ignoreIfExists });
  }
  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.fileOperations.push({ kind: 'delete', uri: uri.toString(), recursive: options?.recursive });
  }
  renameFile(from: Uri, to: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this.fileOperations.push({ kind: 'rename', uri: from.toString(), target: to.toString(), ignoreIfExists: options?.ignoreIfExists });
  }
  get size(): number {
    return this.fileEdits.length + this.fileOperations.length;
  }
  entries(): Array<[Uri, Any[]]> {
    return this.fileEdits.map((edit) => [Uri.parse(edit.uri), edit.edits]);
  }
  getFileOperations() {
    return this.fileOperations;
  }
}

class EventEmitter<T> {
  private listeners = new Set<(event: T) => Any>();
  event = (listener: (event: T) => Any, thisArgs?: Any, disposables?: Any[]): { dispose(): void } => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(disposable);
    return disposable;
  };
  fire(event: T): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        console.error('[extension event handler]', error);
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

class Disposable {
  private callOnDispose: () => Any;
  constructor(callOnDispose: () => Any) {
    this.callOnDispose = callOnDispose;
  }
  static from(...disposables: Array<{ dispose(): Any }>): Disposable {
    return new Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
  }
  dispose(): void {
    this.callOnDispose();
  }
}

class CancellationTokenSource {
  private cancelled = false;
  private emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => Any) => {
      const disposable = this.emitter.event(() => {
        this.token.isCancellationRequested = true;
        listener();
      });
      return disposable;
    },
  };
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, language = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

class SnippetString {
  value: string;
  constructor(value = '') {
    this.value = value;
  }
  appendText(value: string): SnippetString {
    this.value += value.replace(/[$}\\]/g, '\\$&');
    return this;
  }
  appendTabstop(): SnippetString {
    this.value += '$0';
    return this;
  }
  appendPlaceholder(value: string): SnippetString {
    this.value += `\${1:${value}}`;
    return this;
  }
  appendChoice(): SnippetString {
    return this;
  }
  appendVariable(): SnippetString {
    return this;
  }
}

class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

class ThemeIcon {
  id: string;
  color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

class RelativePattern {
  base: string;
  pattern: string;
  constructor(base: Any, pattern: string) {
    this.base = typeof base === 'string' ? base : (base?.uri?.fsPath ?? base?.fsPath ?? '');
    this.pattern = pattern;
  }
}

const unsupportedWarnings = new Set<string>();

export function createVscodeApi(host: ExtensionHost, info: ExtensionInfo): Any {
  const extensionId = info.id;
  const warnUnsupported = (feature: string): void => {
    const key = `${extensionId}:${feature}`;
    if (unsupportedWarnings.has(key)) return;
    unsupportedWarnings.add(key);
    host.output('Extension Host', `[${info.displayName}] ${feature} is not supported by Ter Editor and was ignored.\n`);
  };

  const emitters = {
    open: new EventEmitter<Any>(),
    change: new EventEmitter<Any>(),
    save: new EventEmitter<Any>(),
    close: new EventEmitter<Any>(),
    activeEditor: new EventEmitter<Any>(),
    selection: new EventEmitter<Any>(),
    configuration: new EventEmitter<Any>(),
    workspaceFolders: new EventEmitter<Any>(),
    visibleEditors: new EventEmitter<Any>(),
  };

  const toDiagnosticItem = (diagnostic: Diagnostic): DiagnosticItem => ({
    startLine: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    message: diagnostic.message,
    severity: (['error', 'warning', 'info', 'hint'] as const)[diagnostic.severity] ?? 'error',
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
  });

  const makeDocument = (state: DocState): Any => {
    const lineOffsets = (): number[] => {
      const offsets = [0];
      for (let i = 0; i < state.text.length; i += 1) if (state.text.charCodeAt(i) === 10) offsets.push(i + 1);
      return offsets;
    };
    const lineText = (line: number): string => {
      const lines = state.text.split('\n');
      return lines[Math.max(0, Math.min(line, lines.length - 1))] ?? '';
    };
    const document: Any = {
      uri: Uri.parse(state.uri),
      fileName: state.fsPath,
      get languageId() {
        return state.languageId;
      },
      get version() {
        return state.version;
      },
      get isDirty() {
        return state.dirty;
      },
      isUntitled: false,
      isClosed: false,
      eol: 1,
      encoding: 'utf8',
      get lineCount() {
        return lineOffsets().length;
      },
      getText(range?: Range): string {
        if (!range) return state.text;
        const offsets = lineOffsets();
        const start = (offsets[range.start.line] ?? 0) + range.start.character;
        const end = (offsets[range.end.line] ?? state.text.length) + range.end.character;
        return state.text.slice(start, Math.max(start, end));
      },
      lineAt(lineOrPosition: number | Position): Any {
        const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
        const text = lineText(line);
        const offsets = lineOffsets();
        const startOffset = offsets[line] ?? 0;
        return {
          lineNumber: line,
          text,
          range: new Range(line, 0, line, text.length),
          rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
          firstNonWhitespaceCharacterIndex: text.search(/\S/),
          isEmptyOrWhitespace: text.trim().length === 0,
          getText: () => text,
          get start() {
            return new Position(line, 0);
          },
          get end() {
            return new Position(line, text.length);
          },
          offset: startOffset,
        };
      },
      offsetAt(position: Position): number {
        const offsets = lineOffsets();
        return (offsets[position.line] ?? state.text.length) + position.character;
      },
      positionAt(offset: number): Position {
        const offsets = lineOffsets();
        let line = 0;
        for (let i = 0; i < offsets.length; i += 1) {
          if (offsets[i] <= offset) line = i;
          else break;
        }
        return new Position(line, offset - (offsets[line] ?? 0));
      },
      getWordRangeAtPosition(position: Position): Range | undefined {
        const text = lineText(position.line);
        const pattern = /[\w$-]+/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
          if (position.character >= match.index && position.character <= match.index + match[0].length) {
            return new Range(position.line, match.index, position.line, match.index + match[0].length);
          }
        }
        return undefined;
      },
      validateRange(range: Range): Range {
        const maxLine = lineOffsets().length - 1;
        const clamp = (position: Position): Position =>
          new Position(Math.min(position.line, maxLine), Math.min(position.character, lineText(Math.min(position.line, maxLine)).length));
        return new Range(clamp(range.start), clamp(range.end));
      },
      validatePosition(position: Position): Position {
        return this.validateRange(new Range(position, position)).start;
      },
      save(): Promise<boolean> {
        host.notifyDocumentSave(state.uri);
        return Promise.resolve(true);
      },
    };
    return document;
  };

  const activeState = (): DocState | undefined => {
    const uri = host.getActiveUri();
    return uri ? host.getDocument(uri) : undefined;
  };

  const makeEditor = (state: DocState): Any => {
    const selection = host.getSelection() ?? { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
    const toPosition = (line: number, column: number): Position => new Position(line - 1, column - 1);
    const currentSelection = new Selection(
      toPosition(selection.startLine, selection.startColumn),
      toPosition(selection.endLine, selection.endColumn),
    );
    const applyEdits = async (build: (editBuilder: Any) => void): Promise<boolean> => {
      const edits: Array<{ startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }> = [];
      const builder = {
        replace(range: Range, newText: string) {
          edits.push({
            startLine: range.start.line + 1,
            startColumn: range.start.character + 1,
            endLine: range.end.line + 1,
            endColumn: range.end.character + 1,
            newText,
          });
        },
        insert(position: Position, newText: string) {
          this.replace(new Range(position, position), newText);
        },
        delete(range: Range) {
          this.replace(range, '');
        },
        setEndOfLine() {
          /* newline style is fixed per file */
        },
      };
      build(builder);
      if (edits.length === 0) return true;
      return host.applyWorkspaceEdit([{ uri: state.uri, edits }]);
    };
    return {
      document: makeDocument(state),
      selection: currentSelection,
      selections: [currentSelection],
      viewColumn: 1,
      options: { tabSize: 2, insertSpaces: true },
      visibleRanges: [new Range(0, 0, makeDocument(state).lineCount, 0)],
      edit: applyEdits,
      insertSnippet: async (snippet: SnippetString | string) => {
        const text = typeof snippet === 'string' ? snippet : snippet.value;
        return applyEdits((builder) => builder.insert(currentSelection.active, text));
      },
      revealRange: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      setDecorations: () => undefined,
    };
  };

  const configuration = (section?: string): Any => {
    const prefix = section ? `${section}.` : '';
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return host.getConfigurationValue<T>(`${prefix}${key}`, defaultValue);
      },
      has(key: string): boolean {
        return `${prefix}${key}` in host.getConfigurationDefaults() || `${prefix}${key}` !== '';
      },
      inspect(key: string) {
        const full = `${prefix}${key}`;
        return {
          key: full,
          defaultValue: host.getConfigurationDefaults()[full],
          globalValue: host.getConfigurationValue(full),
        };
      },
      update(key: string, value: unknown): Promise<void> {
        return host.updateConfiguration(`${prefix}${key}`, value);
      },
    };
  };

  const registerCommand = (id: string, callback: (...args: Any[]) => Any, thisArg?: Any) => {
    const handler = thisArg ? callback.bind(thisArg) : callback;
    return host.registerCommand(extensionId, id, handler);
  };

  const statusBarItem = (alignment: 1 | 2, priority: number): Any => {
    const id = `${extensionId}.status.${randomUUID().slice(0, 8)}`;
    let visible = false;
    const item: Any = {
      id,
      alignment,
      priority,
      text: '',
      tooltip: undefined,
      command: undefined,
      color: undefined,
      backgroundColor: undefined,
      name: undefined,
      accessibilityInformation: undefined,
      show: () => {
        visible = true;
        publish();
      },
      hide: () => {
        visible = false;
        host.disposeStatusItem(id);
      },
      dispose: () => {
        visible = false;
        host.disposeStatusItem(id);
      },
    };
    const publish = (): void => {
      if (!visible) return;
      const payload: StatusItem = {
        id,
        alignment: alignment === 2 ? 'right' : 'left',
        priority,
        text: String(item.text ?? ''),
        tooltip: typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value,
        command: typeof item.command === 'string' ? item.command : item.command?.command,
        color: item.color?.id,
      };
      host.setStatusItem(payload);
    };
    return item;
  };

  const outputChannel = (name: string): Any => {
    const channel = {
      name,
      append: (value: string) => host.output(name, value),
      appendLine: (value: string) => host.output(name, `${value}\n`),
      replace: (value: string) => {
        host.clearOutput(name);
        host.output(name, value);
      },
      clear: () => host.clearOutput(name),
      show: () => host.showOutput(name),
      hide: () => undefined,
      dispose: () => undefined,
    };
    return channel;
  };

  const pickLabels = (items: Any[]): string[] =>
    items.map((item) => (typeof item === 'string' ? item : (item?.label ?? '')));

  const api: Any = {
    version: '1.96.0',
    Uri,
    Position,
    Range,
    Selection,
    Location,
    Diagnostic,
    TextEdit,
    WorkspaceEdit,
    EventEmitter,
    Disposable,
    CancellationTokenSource,
    MarkdownString,
    SnippetString,
    ThemeColor,
    ThemeIcon,
    RelativePattern,

    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    EndOfLine: { LF: 1, CRLF: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    CompletionItemKind: {
      Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7,
      Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15,
      File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
      Operator: 23, TypeParameter: 24,
    },
    SymbolKind: { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Function: 11, Variable: 12, Constant: 13, Object: 19 },

    env: {
      appName: 'Ter Editor',
      appRoot: path.dirname(info.path),
      appHost: 'desktop',
      language: 'en',
      machineId: createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 32),
      sessionId: randomUUID(),
      uiKind: 1,
      isTelemetryEnabled: false,
      remoteName: undefined,
      shell: process.env.SHELL ?? undefined,
      onDidChangeTelemetryEnabled: new EventEmitter<boolean>().event,
      openExternal: async (uri: Uri) => {
        host.getDelegate().send({ kind: 'log', message: `Extension opened ${uri.toString()}` });
      },
      asExternalUri: async (uri: Uri) => uri,
      clipboard: {
        readText: async () => await host.getDelegate().clipboardRead(),
        writeText: async (value: string) => host.getDelegate().clipboardWrite(value),
      },
    },

    commands: {
      registerCommand,
      registerTextEditorCommand: (id: string, callback: Any, thisArg?: Any) => {
        const handler = (...args: Any[]) => {
          const state = activeState();
          return callback.call(thisArg ?? null, state ? makeEditor(state) : undefined, undefined, ...args);
        };
        return host.registerCommand(extensionId, id, handler);
      },
      executeCommand: async (id: string, ...args: Any[]) => {
        if (id === 'setContext') return undefined;
        if (id === 'vscode.open' && args[0] instanceof Uri) {
          await host.openDocument(args[0].toString());
          return undefined;
        }
        return host.executeCommand(id, args);
      },
      getCommands: async () => host.getCommands().map((command) => command.id),
    },

    window: {
      get activeTextEditor() {
        const state = activeState();
        return state ? makeEditor(state) : undefined;
      },
      get visibleTextEditors() {
        const state = activeState();
        return state ? [makeEditor(state)] : [];
      },
      get terminals() {
        return [];
      },
      state: { focused: true, active: true },
      onDidChangeActiveTextEditor: emitters.activeEditor.event,
      onDidChangeTextEditorSelection: emitters.selection.event,
      onDidChangeVisibleTextEditors: emitters.visibleEditors.event,
      onDidChangeTextEditorVisibleRanges: new EventEmitter<Any>().event,
      onDidChangeWindowState: new EventEmitter<Any>().event,
      onDidOpenTerminal: new EventEmitter<Any>().event,
      onDidCloseTerminal: new EventEmitter<Any>().event,
      onDidChangeTerminalState: new EventEmitter<Any>().event,
      showInformationMessage: (message: string, ...items: Any[]) =>
        host.getDelegate().request<number | undefined>('message', { level: 'info', message, items: pickLabels(items) }),
      showWarningMessage: (message: string, ...items: Any[]) =>
        host.getDelegate().request<number | undefined>('message', { level: 'warning', message, items: pickLabels(items) }),
      showErrorMessage: (message: string, ...items: Any[]) =>
        host.getDelegate().request<number | undefined>('message', { level: 'error', message, items: pickLabels(items) }),
      showQuickPick: async (items: Any, options?: Any) => {
        const resolved = await items;
        const labels = pickLabels(resolved);
        const picked = await host.getDelegate().request<number | number[] | undefined>('quickPick', {
          items: resolved.map((item: Any, index: number) => ({
            label: labels[index],
            description: item?.description,
            detail: item?.detail,
            picked: item?.picked,
          })),
          placeholder: options?.placeHolder ?? options?.title,
          canPickMany: Boolean(options?.canPickMany),
        });
        if (picked === undefined) return undefined;
        if (Array.isArray(picked)) return picked.map((index: number) => resolved[index]).filter(Boolean);
        return resolved[picked];
      },
      showInputBox: (options?: Any) =>
        host.getDelegate().request<string | undefined>('inputBox', {
          prompt: options?.prompt,
          placeHolder: options?.placeHolder,
          value: options?.value,
          password: Boolean(options?.password),
          title: options?.title,
        }),
      showTextDocument: async (documentOrUri: Any) => {
        const uri = documentOrUri instanceof Uri ? documentOrUri.toString() : (documentOrUri?.uri?.toString?.() ?? String(documentOrUri));
        const state = await host.openDocument(uri);
        return makeEditor(state);
      },
      showOpenDialog: async (options?: Any) => {
        const paths = await host.getDelegate().openDialog({
          title: options?.title,
          canSelectFolders: Boolean(options?.canSelectFolders),
          canSelectFiles: options?.canSelectFiles !== false,
          canSelectMany: Boolean(options?.canSelectMany),
        });
        return paths ? paths.map((fsPath) => Uri.file(fsPath)) : undefined;
      },
      showSaveDialog: async (options?: Any) => {
        const fsPath = await host.getDelegate().saveDialog({ title: options?.title, defaultPath: options?.defaultUri?.fsPath });
        return fsPath ? Uri.file(fsPath) : undefined;
      },
      createStatusBarItem: (alignmentOrId?: Any, priority?: number) => {
        const alignment = alignmentOrId === 2 || alignmentOrId === 'right' ? 2 : 1;
        return statusBarItem(alignment as 1 | 2, priority ?? 0);
      },
      setStatusBarMessage: (text: string, timeoutOrThenable?: Any) => {
        const item = statusBarItem(1, -500);
        item.text = text;
        item.show();
        if (typeof timeoutOrThenable === 'number') setTimeout(() => item.dispose(), timeoutOrThenable);
        else if (timeoutOrThenable?.then) void timeoutOrThenable.then(() => item.dispose());
        else setTimeout(() => item.dispose(), 5000);
        return { dispose: () => item.dispose() };
      },
      createOutputChannel: (name: string) => outputChannel(name),
      withProgress: async (options: Any, task: Any) => {
        const tokenSource = new CancellationTokenSource();
        host.getDelegate().send({ kind: 'progress', active: true, title: options?.title ?? 'Working…' });
        try {
          return await task({ report: () => undefined }, tokenSource.token);
        } finally {
          host.getDelegate().send({ kind: 'progress', active: false, title: '' });
          tokenSource.dispose();
        }
      },
      createTextEditorDecorationType: () => {
        warnUnsupported('text editor decorations');
        return { key: randomUUID(), dispose: () => undefined };
      },
      registerWebviewViewProvider: () => {
        warnUnsupported('webview views');
        return { dispose: () => undefined };
      },
      registerWebviewPanelSerializer: () => {
        warnUnsupported('webview panels');
        return { dispose: () => undefined };
      },
      createWebviewPanel: () => {
        throw new Error('Ter Editor does not implement webview panels. This extension feature is unavailable.');
      },
      createTerminal: () => {
        throw new Error('Ter Editor does not implement an integrated terminal. This extension feature is unavailable.');
      },
      createTreeView: () => {
        warnUnsupported('tree views');
        return { dispose: () => undefined, onDidChangeSelection: new EventEmitter<Any>().event, onDidChangeVisibility: new EventEmitter<Any>().event, onDidExpandElement: new EventEmitter<Any>().event };
      },
      registerTreeDataProvider: () => {
        warnUnsupported('tree views');
        return { dispose: () => undefined };
      },
      registerUriHandler: () => {
        warnUnsupported('URI handlers');
        return { dispose: () => undefined };
      },
    },

    workspace: {
      get workspaceFolders() {
        const root = host.workspaceRoot();
        return root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : undefined;
      },
      get rootPath() {
        return host.workspaceRoot() ?? undefined;
      },
      get name() {
        const root = host.workspaceRoot();
        return root ? path.basename(root) : undefined;
      },
      workspaceFile: undefined,
      get textDocuments() {
        return host.getDocuments().map((state) => makeDocument(state));
      },
      getConfiguration: (section?: string) => configuration(section),
      getWorkspaceFolder: (uri: Uri) => {
        const root = host.workspaceRoot();
        if (!root) return undefined;
        const candidate = uri.fsPath ?? '';
        return candidate.startsWith(root) ? { uri: Uri.file(root), name: path.basename(root), index: 0 } : undefined;
      },
      asRelativePath: (pathOrUri: string | Uri) => {
        const root = host.workspaceRoot();
        const target = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        if (!root) return target;
        const relative = path.relative(root, target);
        return relative.startsWith('..') ? target : relative.split(path.sep).join('/');
      },
      openTextDocument: async (uriOrPath?: Any) => {
        if (typeof uriOrPath === 'string') {
          const state = await host.openDocument(Uri.file(uriOrPath).toString());
          return makeDocument(state);
        }
        if (uriOrPath instanceof Uri) {
          const state = await host.openDocument(uriOrPath.toString());
          return makeDocument(state);
        }
        if (uriOrPath?.content !== undefined) {
          throw new Error('Untitled documents are not supported by Ter Editor.');
        }
        const state = activeState();
        if (!state) throw new Error('No active document');
        return makeDocument(state);
      },
      applyEdit: async (edit: WorkspaceEdit) => {
        const payload = edit.entries().map(([uri, edits]: [Uri, Any[]]) => ({
          uri: uri.toString(),
          edits: edits.map((item: Any) => ({
            startLine: item.startLine,
            startColumn: item.startColumn,
            endLine: item.endLine,
            endColumn: item.endColumn,
            newText: item.newText,
          })),
        }));
        let success = true;
        if (payload.length > 0) success = await host.applyWorkspaceEdit(payload);
        const fsp = await import('node:fs/promises');
        for (const operation of edit.getFileOperations()) {
          try {
            const target = uriToPath(operation.uri);
            if (operation.kind === 'create') {
              await fsp.mkdir(path.dirname(target), { recursive: true });
              if (operation.ignoreIfExists) {
                try {
                  await fsp.access(target);
                  continue;
                } catch {
                  /* does not exist yet */
                }
              }
              await fsp.writeFile(target, '', { flag: 'wx' });
            } else if (operation.kind === 'delete') {
              await fsp.rm(target, { recursive: true, force: true });
            } else if (operation.kind === 'rename' && operation.target) {
              await fsp.rename(target, uriToPath(operation.target));
            }
          } catch {
            success = false;
          }
        }
        return success;
      },
      save: async (uri?: Uri) => {
        if (uri) host.notifyDocumentSave(uri.toString());
        return true;
      },
      saveAll: async () => {
        for (const state of host.getDocuments()) host.notifyDocumentSave(state.uri);
        return true;
      },
      findFiles: async (include: string | RelativePattern, exclude?: string | null, maxResults = 1000) => {
        const pattern = typeof include === 'string' ? include : include.pattern;
        const files = await host.findFiles(pattern, exclude ?? undefined, maxResults);
        return files.map((fsPath) => Uri.file(fsPath));
      },
      createFileSystemWatcher: (globPattern: string | RelativePattern) => {
        const pattern = typeof globPattern === 'string' ? globPattern : globPattern.pattern;
        const watcher = host.createWatcher(pattern, {
          create: (uri) => emitters.open.fire(Uri.parse(uri)),
          change: (uri) => emitters.change.fire(Uri.parse(uri)),
          delete: (uri) => emitters.close.fire(Uri.parse(uri)),
        });
        return {
          ignoreCreateEvents: false,
          ignoreChangeEvents: false,
          ignoreDeleteEvents: false,
          onDidCreate: new EventEmitter<Uri>().event,
          onDidChange: new EventEmitter<Uri>().event,
          onDidDelete: new EventEmitter<Uri>().event,
          dispose: () => watcher.dispose(),
        };
      },
      fs: {
        readFile: async (uri: Uri) => new Uint8Array(await (await import('node:fs/promises')).readFile(uri.fsPath)),
        writeFile: async (uri: Uri, content: Uint8Array) => (await import('node:fs/promises')).writeFile(uri.fsPath, content),
        readDirectory: async (uri: Uri): Promise<Array<[string, number]>> => {
          const fsp = await import('node:fs/promises');
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry): [string, number] => [
            entry.name,
            entry.isDirectory() ? 2 : entry.isSymbolicLink() ? 64 : 1,
          ]);
        },
        stat: async (uri: Uri) => (await import('node:fs/promises')).stat(uri.fsPath),
        delete: async (uri: Uri, options?: { recursive?: boolean }) => (await import('node:fs/promises')).rm(uri.fsPath, { recursive: Boolean(options?.recursive) }),
        createDirectory: async (uri: Uri) => (await import('node:fs/promises')).mkdir(uri.fsPath, { recursive: true }),
        rename: async (from: Uri, to: Uri) => (await import('node:fs/promises')).rename(from.fsPath, to.fsPath),
        copy: async (from: Uri, to: Uri) => (await import('node:fs/promises')).cp(from.fsPath, to.fsPath, { recursive: true }),
        isWritableFileSystem: () => true,
      },
      onDidOpenTextDocument: emitters.open.event,
      onDidChangeTextDocument: emitters.change.event,
      onDidSaveTextDocument: emitters.save.event,
      onDidCloseTextDocument: emitters.close.event,
      onDidChangeConfiguration: emitters.configuration.event,
      onDidChangeWorkspaceFolders: emitters.workspaceFolders.event,
      onWillSaveTextDocument: new EventEmitter<Any>().event,
      onWillSaveTextDocument2: undefined,
      onDidCreateFiles: new EventEmitter<Any>().event,
      onDidDeleteFiles: new EventEmitter<Any>().event,
      onDidRenameFiles: new EventEmitter<Any>().event,
      onWillCreateFiles: new EventEmitter<Any>().event,
      onWillDeleteFiles: new EventEmitter<Any>().event,
      onWillRenameFiles: new EventEmitter<Any>().event,
      updateWorkspaceFolders: () => false,
      registerFileSystemProvider: () => {
        warnUnsupported('file system providers');
        return { dispose: () => undefined };
      },
    },

    languages: {
      createDiagnosticCollection: (name = `collection-${randomUUID().slice(0, 6)}`) => {
        const id = `${extensionId}.${name}`;
        const store = new Map<string, DiagnosticItem[]>();
        const apply = (uri: Uri, diagnostics: Diagnostic[]): void => {
          const items = diagnostics.map(toDiagnosticItem);
          if (items.length === 0) store.delete(uri.toString());
          else store.set(uri.toString(), items);
          host.updateDiagnostics(id, uri.toString(), items);
        };
        const collection: Any = {
          name,
          set: (uriOrEntries: Any, diagnostics?: Diagnostic[]) => {
            if (Array.isArray(uriOrEntries)) {
              for (const [uri, items] of uriOrEntries) apply(uri, items ?? []);
            } else if (diagnostics) {
              apply(uriOrEntries, diagnostics);
            }
          },
          delete: (uri: Uri) => apply(uri, []),
          clear: () => {
            for (const uri of Array.from(store.keys())) host.updateDiagnostics(id, uri, []);
            store.clear();
          },
          has: (uri: Uri) => store.has(uri.toString()),
          get: (uri: Uri) => store.get(uri.toString()),
          forEach: (callback: (uri: Uri, diagnostics: DiagnosticItem[]) => void) => {
            for (const [uri, diagnostics] of store) callback(Uri.parse(uri), diagnostics);
          },
          dispose: () => {
            host.clearDiagnostics(id);
            store.clear();
          },
        };
        return collection;
      },
      getDiagnostics: (uri?: Uri) => {
        if (uri) return [] as DiagnosticItem[];
        return [] as Array<[Uri, DiagnosticItem[]]>;
      },
      onDidChangeDiagnostics: new EventEmitter<Any>().event,
      getLanguages: async () =>
        EXTRA_LANGUAGES.map((language) => ({ id: language.id, aliases: [language.label, language.id], extensions: [] as string[] })),
      match: () => 10,
      setLanguageConfiguration: () => ({ dispose: () => undefined }),
      registerCompletionItemProvider: () => {
        warnUnsupported('completion providers');
        return { dispose: () => undefined };
      },
      registerHoverProvider: () => {
        warnUnsupported('hover providers');
        return { dispose: () => undefined };
      },
      registerDefinitionProvider: () => {
        warnUnsupported('definition providers');
        return { dispose: () => undefined };
      },
      registerDocumentFormattingEditProvider: () => {
        warnUnsupported('formatting providers');
        return { dispose: () => undefined };
      },
      registerDocumentSymbolProvider: () => {
        warnUnsupported('document symbol providers');
        return { dispose: () => undefined };
      },
      registerCodeActionsProvider: () => {
        warnUnsupported('code action providers');
        return { dispose: () => undefined };
      },
      createLanguageStatusItem: () => ({ dispose: () => undefined, text: '', severity: 0, command: undefined, name: '' }),
    },

    extensions: {
      getExtension: (id: string) => {
        const extensionInfo = host.getExtensionInfo(id) ?? (id.toLowerCase() === extensionId ? info : undefined);
        if (!extensionInfo) return undefined;
        return {
          id: extensionInfo.id,
          extensionPath: extensionInfo.path,
          extensionUri: Uri.file(extensionInfo.path),
          isActive: host.getExtensionExports(extensionInfo.id) !== undefined,
          packageJSON: { name: extensionInfo.name, publisher: extensionInfo.publisher, version: extensionInfo.version, displayName: extensionInfo.displayName },
          exports: host.getExtensionExports(extensionInfo.id),
          activate: async () => host.getExtensionExports(extensionInfo.id),
        };
      },
      get all() {
        return host.listExtensionInfos().map((extensionInfo) => ({
          id: extensionInfo.id,
          extensionPath: extensionInfo.path,
          extensionUri: Uri.file(extensionInfo.path),
          isActive: host.getExtensionExports(extensionInfo.id) !== undefined,
          exports: host.getExtensionExports(extensionInfo.id),
          packageJSON: { name: extensionInfo.name, publisher: extensionInfo.publisher, version: extensionInfo.version, displayName: extensionInfo.displayName },
          activate: async () => host.getExtensionExports(extensionInfo.id),
        }));
      },
      onDidChange: new EventEmitter<Any>().event,
    },

    __emit: (event: string, uri: string) => {
      const state = host.getDocument(uri);
      const document = state ? makeDocument(state) : undefined;
      if (event === 'onDidOpenTextDocument' && document) emitters.open.fire(document);
      if (event === 'onDidChangeTextDocument' && document) emitters.change.fire({ document, contentChanges: [{ range: new Range(0, 0, 0, 0), rangeOffset: 0, rangeLength: 0, text: '' }], reason: undefined });
      if (event === 'onDidSaveTextDocument' && document) emitters.save.fire(document);
      if (event === 'onDidCloseTextDocument' && document) emitters.close.fire(document);
      if (event === 'onDidChangeActiveTextEditor') emitters.activeEditor.fire(document);
      if (event === 'onDidChangeTextEditorSelection' && document) {
        const selection = host.getSelection();
        const editor = makeEditor(state!);
        if (selection) {
          editor.selection = new Selection(
            new Position(selection.startLine - 1, selection.startColumn - 1),
            new Position(selection.endLine - 1, selection.endColumn - 1),
          );
          editor.selections = [editor.selection];
        }
        emitters.selection.fire({ textEditor: editor, selections: editor.selections, kind: 3 });
      }
      if (event === 'onDidChangeConfiguration') {
        emitters.configuration.fire({ affectsConfiguration: (section: string) => section === '' || uri.startsWith(section) });
      }
    },
  };

  // Language labels and theme helpers used by the renderer's snippet/theme loaders.
  api.__languageLabel = (languageId: string) => labelForLanguage(languageId);
  api.__languageForPath = (fsPath: string) => languageForPath(fsPath);
  api.__themeRules = (rules: ThemeRule[]) => rules;

  return api;
}
