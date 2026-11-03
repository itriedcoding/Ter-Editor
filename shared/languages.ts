/**
 * Language mapping.
 *
 * Two layers:
 *  - Monaco ships real tokenizers for ~85 languages (basic-languages). This table
 *    maps file names/extensions onto them so files open highlighted.
 *  - Languages Monaco does not tokenize are still registered with a proper id and
 *    label; they receive real syntax highlighting when a VS Code language
 *    extension (TextMate grammar) for them is installed, which is how VS Code
 *    itself extends its language set.
 */

export interface LanguageDescriptor {
  id: string;
  label: string;
  /** Monaco has a bundled tokenizer for this id. */
  builtin: boolean;
}

/** Languages without a Monaco tokenizer. Registered so extensions can attach grammars. */
export const EXTRA_LANGUAGES: LanguageDescriptor[] = [
  { id: 'haskell', label: 'Haskell', builtin: false },
  { id: 'ocaml', label: 'OCaml', builtin: false },
  { id: 'erlang', label: 'Erlang', builtin: false },
  { id: 'elm', label: 'Elm', builtin: false },
  { id: 'purescript', label: 'PureScript', builtin: false },
  { id: 'nim', label: 'Nim', builtin: false },
  { id: 'zig', label: 'Zig', builtin: false },
  { id: 'crystal', label: 'Crystal', builtin: false },
  { id: 'dlang', label: 'D', builtin: false },
  { id: 'vala', label: 'Vala', builtin: false },
  { id: 'groovy', label: 'Groovy', builtin: false },
  { id: 'nix', label: 'Nix', builtin: false },
  { id: 'cmake', label: 'CMake', builtin: false },
  { id: 'makefile', label: 'Makefile', builtin: false },
  { id: 'latex', label: 'LaTeX', builtin: false },
  { id: 'fortran', label: 'Fortran', builtin: false },
  { id: 'cobol', label: 'COBOL', builtin: false },
  { id: 'ada', label: 'Ada', builtin: false },
  { id: 'vhdl', label: 'VHDL', builtin: false },
  { id: 'verilog', label: 'Verilog', builtin: false },
  { id: 'matlab', label: 'MATLAB', builtin: false },
  { id: 'octave', label: 'Octave', builtin: false },
  { id: 'sas', label: 'SAS', builtin: false },
  { id: 'stata', label: 'Stata', builtin: false },
  { id: 'prolog', label: 'Prolog', builtin: false },
  { id: 'sml', label: 'Standard ML', builtin: false },
  { id: 'reason', label: 'Reason', builtin: false },
  { id: 'vue', label: 'Vue', builtin: false },
  { id: 'svelte', label: 'Svelte', builtin: false },
  { id: 'astro', label: 'Astro', builtin: false },
  { id: 'move', label: 'Move', builtin: false },
  { id: 'cairo', label: 'Cairo', builtin: false },
  { id: 'vyper', label: 'Vyper', builtin: false },
  { id: 'wat', label: 'WebAssembly', builtin: false },
  { id: 'gleam', label: 'Gleam', builtin: false },
  { id: 'odin', label: 'Odin', builtin: false },
  { id: 'roc', label: 'Roc', builtin: false },
  { id: 'raku', label: 'Raku', builtin: false },
  { id: 'coffeescript', label: 'CoffeeScript', builtin: false },
  { id: 'pascal', label: 'Pascal', builtin: true },
  { id: 'textproto', label: 'Protocol Buffers Text', builtin: false },
  { id: 'properties', label: 'Properties', builtin: false },
  { id: 'csv', label: 'CSV', builtin: false },
  { id: 'dotenv', label: 'Dotenv', builtin: false },
  { id: 'nginx', label: 'Nginx', builtin: false },
  { id: 'apache', label: 'Apache Conf', builtin: false },
  { id: 'solidity', label: 'Solidity', builtin: true },
];

const EXT_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte', astro: 'astro',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'css',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', rst: 'restructuredtext',
  py: 'python', pyw: 'python', pyi: 'python', ipynb: 'json',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby',
  go: 'go', rs: 'rust',
  java: 'java', jsp: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', ipp: 'cpp', ino: 'cpp',
  cs: 'csharp', csx: 'csharp', fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp', vb: 'vb',
  php: 'php', phtml: 'php', swift: 'swift', m: 'objective-c', mm: 'objective-c',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  sql: 'sql', mysql: 'mysql', pgsql: 'pgsql', plsql: 'sql', redshift: 'redshift',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', env: 'dotenv',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', csproj: 'xml', nuspec: 'xml',
  dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', thrift: 'textproto',
  lua: 'lua', r: 'r', jl: 'julia', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', lisp: 'scheme', scm: 'scheme', rkt: 'scheme',
  hs: 'haskell', lhs: 'haskell', ml: 'ocaml', mli: 'ocaml', elm: 'elm', purs: 'purescript',
  nim: 'nim', zig: 'zig', cr: 'crystal', d: 'dlang', vala: 'vala', groovy: 'groovy', gradle: 'groovy',
  nix: 'nix', cmake: 'cmake', mk: 'makefile', tex: 'latex', sty: 'latex', cls: 'latex', bib: 'latex',
  f: 'fortran', f90: 'fortran', f95: 'fortran', f03: 'fortran', cbl: 'cobol', cob: 'cobol', adb: 'ada', ads: 'ada',
  vhd: 'vhdl', vhdl: 'vhdl', v: 'verilog', sv: 'systemverilog', svh: 'systemverilog', vh: 'verilog',
  mat: 'matlab', m4: 'matlab', sas: 'sas', do: 'stata', ado: 'stata', pro: 'prolog', sig: 'sml', fun: 'sml',
  re: 'reason', rei: 'reason', move: 'move', cairo: 'cairo', vy: 'vyper', wat: 'wat', wast: 'wat',
  gleam: 'gleam', odin: 'odin', roc: 'roc', raku: 'raku', p6: 'raku', pm: 'perl', pl: 'perl', t: 'perl',
  coffee: 'coffeescript', pas: 'pascal', pp: 'pascal', dpr: 'pascal', tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  sol: 'solidity', bicep: 'bicep', abap: 'abap', apex: 'apex', clsx: 'apex',
  hbs: 'handlebars', mustache: 'handlebars', pug: 'pug', jade: 'pug', twig: 'twig', liquid: 'liquid',
  csv: 'csv', tsv: 'csv', nginx: 'nginx', sub: 'systemverilog',
  bzl: 'python', star: 'python', cu: 'cpp', cuh: 'cpp', hh: 'cpp', glsl: 'cpp', vert: 'cpp', frag: 'cpp',
  wgsl: 'wgsl', qs: 'qsharp', cql: 'sql', cypher: 'cypher', sparql: 'sparql', rq: 'sparql',
  bpmn: 'xml', drawio: 'xml', graphml: 'xml', sld: 'xml',
  mjsx: 'javascript', txt: 'plaintext', log: 'plaintext', gitignore: 'plaintext', npmrc: 'ini', editorconfig: 'ini',
  lock: 'plaintext', patch: 'plaintext', diff: 'plaintext',
};

const FILENAME_MAP: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'package.json': 'json',
  'tsconfig.json': 'json',
  'cargo.toml': 'ini',
  'go.mod': 'go',
  'go.sum': 'plaintext',
  'pom.xml': 'xml',
  'build.gradle': 'groovy',
  'requirements.txt': 'plaintext',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  '.gitignore': 'plaintext',
  '.dockerignore': 'plaintext',
  '.env': 'dotenv',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  'nginx.conf': 'nginx',
  'httpd.conf': 'apache',
  'crontab': 'shell',
  'procfile': 'plaintext',
};

const LABELS = new Map<string, string>();
for (const lang of EXTRA_LANGUAGES) LABELS.set(lang.id, lang.label);

const MONACO_LABELS: Record<string, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', html: 'HTML', css: 'CSS',
  scss: 'SCSS', less: 'Less', markdown: 'Markdown', mdx: 'MDX', python: 'Python', ruby: 'Ruby',
  go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', scala: 'Scala', cpp: 'C/C++',
  csharp: 'C#', fsharp: 'F#', vb: 'Visual Basic', php: 'PHP', swift: 'Swift',
  'objective-c': 'Objective-C', shell: 'Shell Script', powershell: 'PowerShell', bat: 'Batch',
  sql: 'SQL', mysql: 'MySQL', pgsql: 'PostgreSQL', redshift: 'Redshift', yaml: 'YAML', ini: 'INI',
  xml: 'XML', dockerfile: 'Dockerfile', graphql: 'GraphQL', protobuf: 'Protocol Buffers',
  lua: 'Lua', r: 'R', julia: 'Julia', dart: 'Dart', elixir: 'Elixir', clojure: 'Clojure',
  scheme: 'Scheme', perl: 'Perl', coffeescript: 'CoffeeScript', pascal: 'Pascal', hcl: 'HCL',
  solidity: 'Solidity', bicep: 'Bicep', abap: 'ABAP', apex: 'Apex', handlebars: 'Handlebars',
  pug: 'Pug', twig: 'Twig', liquid: 'Liquid', cypher: 'Cypher', sparql: 'SPARQL',
  systemverilog: 'SystemVerilog', wgsl: 'WGSL', qsharp: 'Q#', restructuredtext: 'reStructuredText',
  plaintext: 'Plain Text', mips: 'MIPS Assembly', 'm3': 'Modula-3', csp: 'CSP', ecl: 'ECL',
  'freemarker2': 'FreeMarker', lexon: 'Lexon', liquid_: 'Liquid', msdax: 'MSDAX',
  postiats: 'ATS', powerquery: 'Power Query', razor: 'Razor', redis: 'Redis', sb: 'Small Basic',
  sophia: 'Sophia', st: 'Structured Text', tcl: 'Tcl', pla: 'PLA', typespec: 'TypeSpec',
  cameligo: 'CameLIGO', pascaligo: 'PascalLIGO', flow9: 'Flow9', azcli: 'Azure CLI',
  csv: 'CSV', dotenv: 'Dotenv', nginx: 'Nginx', apache: 'Apache Conf', properties: 'Properties',
  textproto: 'Protocol Buffers Text',
};
for (const [id, label] of Object.entries(MONACO_LABELS)) if (!LABELS.has(id)) LABELS.set(id, label);

export function labelForLanguage(id: string): string {
  return LABELS.get(id) ?? id.replace(/(^|-)(\w)/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase());
}

export function languageForPath(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower];
  if (lower.startsWith('.env')) return 'dotenv';
  if (lower.startsWith('dockerfile')) return 'dockerfile';
  if (lower.startsWith('makefile')) return 'makefile';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = lower.slice(dot + 1);
  return EXT_MAP[ext] ?? 'plaintext';
}

export function isBinaryExt(filePath: string): boolean {
  const ext = filePath.replace(/\\/g, '/').split('.').pop()?.toLowerCase() ?? '';
  return [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tiff',
    'mp3', 'mp4', 'mov', 'wav', 'ogg', 'webm', 'mkv', 'avi', 'flac',
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
    'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot',
    'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'lib', 'class', 'jar', 'wasm', 'node',
    'db', 'sqlite', 'sqlite3', 'bin', 'dat', 'pyc', 'pdb', 'vsix', 'asar',
  ].includes(ext);
}

export const ALL_LANGUAGE_IDS: string[] = Array.from(
  new Set([...EXTRA_LANGUAGES.map((l) => l.id), ...Object.values(EXT_MAP), ...Object.values(FILENAME_MAP), ...Object.keys(MONACO_LABELS)]),
);
