import * as monaco from 'monaco-editor';
import { Registry, INITIAL, type IGrammar, type StateStack } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { EXTRA_LANGUAGES, labelForLanguage } from '../../shared/languages';
import type { ExtensionInfo } from '../../shared/ipc';
import { ter } from './bridge';

interface GrammarEntry {
  scopeName: string;
  languageId?: string;
  contents: string;
}

const grammars = new Map<string, GrammarEntry>();
const loadedLanguages = new Set<string>();
let registryPromise: Promise<Registry> | null = null;
let registeredLanguages = new Set<string>();

/** Registers extra language ids that Monaco does not ship a tokenizer for. */
export function registerExtraLanguages(): void {
  for (const language of EXTRA_LANGUAGES) {
    if (language.builtin) continue;
    monaco.languages.register({ id: language.id, aliases: [language.label] });
    registeredLanguages.add(language.id);
  }
}

function getRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const bytes = await window.terInternals.oniguruma();
      await loadWASM({ data: bytes });
      return new Registry({
        onigLib: Promise.resolve({
          createOnigScanner: (patterns: string[]) => createOnigScanner(patterns),
          createOnigString: (value: string) => createOnigString(value),
        }),
        loadGrammar: async (scopeName: string) => {
          const entry = grammars.get(scopeName);
          if (!entry) return null;
          return {
            scopeName: entry.scopeName,
            fileTypes: [],
            name: entry.scopeName,
            patterns: [],
            repository: {},
            ...JSON.parse(entry.contents),
          } as never;
        },
      });
    })();
  }
  return registryPromise;
}

/**
 * Installs a Monaco tokens provider backed by the extension's TextMate grammar.
 * Monaco themes match dotted token types by prefix, so VS Code theme rules apply.
 */
async function installGrammar(languageId: string, scopeName: string): Promise<boolean> {
  if (loadedLanguages.has(languageId)) return true;
  const registry = await getRegistry();
  let grammar: IGrammar | null = null;
  try {
    grammar = await registry.loadGrammar(scopeName);
  } catch {
    return false;
  }
  if (!grammar) return false;
  const active = grammar;

  if (!registeredLanguages.has(languageId)) {
    const known = monaco.languages.getLanguages().some((language) => language.id === languageId);
    if (!known) monaco.languages.register({ id: languageId, aliases: [labelForLanguage(languageId)] });
    registeredLanguages.add(languageId);
  }

  monaco.languages.setTokensProvider(languageId, {
    getInitialState: () => INITIAL as StateStack,
    tokenize(line: string, state: StateStack) {
      const result = active.tokenizeLine(line, state);
      return {
        endState: result.ruleStack,
        tokens: result.tokens.map((token) => ({
          startIndex: token.startIndex,
          scopes: token.scopes[token.scopes.length - 1],
        })),
      };
    },
  });
  loadedLanguages.add(languageId);
  return true;
}

/**
 * Reads every enabled extension's grammar contributions and installs them.
 * Extensions are re-read on install/uninstall, mirroring how VS Code activates
 * language packs.
 */
export async function applyExtensionGrammars(extensions: ExtensionInfo[]): Promise<number> {
  let installed = 0;
  for (const extension of extensions) {
    if (!extension.enabled || extension.extends.grammars.length === 0) continue;
    for (const grammar of extension.extends.grammars) {
      try {
        const contents = await ter.extensions.readAsset(extension.id, grammar.path);
        grammars.set(grammar.scopeName, { scopeName: grammar.scopeName, languageId: grammar.language, contents });
      } catch {
        continue;
      }
    }
    for (const grammar of extension.extends.grammars) {
      if (!grammar.language) continue;
      try {
        if (await installGrammar(grammar.language, grammar.scopeName)) installed += 1;
      } catch {
        continue;
      }
    }
    // Languages contributed by the extension are registered even when their
    // grammar could not be parsed, so files get the correct language label.
    for (const language of extension.extends.languages) {
      if (!registeredLanguages.has(language.id) && !monaco.languages.getLanguages().some((entry) => entry.id === language.id)) {
        monaco.languages.register({ id: language.id, aliases: language.aliases });
        registeredLanguages.add(language.id);
      }
    }
  }
  return installed;
}


export function hasTextMateSupport(languageId: string): boolean {
  return loadedLanguages.has(languageId);
}
