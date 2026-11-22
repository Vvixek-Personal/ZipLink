import { getLowerExtension } from './zipSecurity.ts';

export type CodeLanguageId =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'html'
  | 'css'
  | 'scss'
  | 'python'
  | 'markdown'
  | 'yaml'
  | 'xml'
  | 'svg'
  | 'shell'
  | 'sql'
  | 'toml'
  | 'plaintext';

export interface LanguageSpec {
  id: CodeLanguageId;
  label: string;
}

const EXTENSION_MAP: Record<string, LanguageSpec> = {
  '.js': { id: 'javascript', label: 'JavaScript' },
  '.mjs': { id: 'javascript', label: 'JavaScript (ESM)' },
  '.cjs': { id: 'javascript', label: 'JavaScript (CJS)' },
  '.jsx': { id: 'jsx', label: 'JSX' },
  '.ts': { id: 'typescript', label: 'TypeScript' },
  '.mts': { id: 'typescript', label: 'TypeScript' },
  '.cts': { id: 'typescript', label: 'TypeScript' },
  '.tsx': { id: 'tsx', label: 'TSX' },
  '.json': { id: 'json', label: 'JSON' },
  '.jsonc': { id: 'json', label: 'JSON' },
  '.html': { id: 'html', label: 'HTML' },
  '.htm': { id: 'html', label: 'HTML' },
  '.xhtml': { id: 'html', label: 'XHTML' },
  '.css': { id: 'css', label: 'CSS' },
  '.scss': { id: 'scss', label: 'SCSS' },
  '.py': { id: 'python', label: 'Python' },
  '.pyw': { id: 'python', label: 'Python' },
  '.md': { id: 'markdown', label: 'Markdown' },
  '.markdown': { id: 'markdown', label: 'Markdown' },
  '.mdx': { id: 'markdown', label: 'Markdown' },
  '.yaml': { id: 'yaml', label: 'YAML' },
  '.yml': { id: 'yaml', label: 'YAML' },
  '.xml': { id: 'xml', label: 'XML' },
  '.svg': { id: 'svg', label: 'SVG (XML)' },
  '.sh': { id: 'shell', label: 'Shell' },
  '.bash': { id: 'shell', label: 'Bash' },
  '.zsh': { id: 'shell', label: 'Zsh' },
  '.ksh': { id: 'shell', label: 'Shell' },
  '.sql': { id: 'sql', label: 'SQL' },
  '.toml': { id: 'toml', label: 'TOML' },
};

const BASENAME_MAP: Record<string, LanguageSpec> = {
  dockerfile: { id: 'shell', label: 'Dockerfile / Shell' },
  makefile: { id: 'shell', label: 'Makefile' },
  '.bashrc': { id: 'shell', label: 'Bash' },
  '.zshrc': { id: 'shell', label: 'Zsh' },
  '.bash_profile': { id: 'shell', label: 'Bash' },
  '.gitignore': { id: 'plaintext', label: 'Plain Text' },
  '.env.example': { id: 'shell', label: 'Env Template' },
  'package.json': { id: 'json', label: 'JSON' },
  'tsconfig.json': { id: 'json', label: 'JSON' },
};

export function detectLanguageFromPath(relativePath: string): LanguageSpec {
  const baseName = (relativePath.split('/').pop() ?? '').toLowerCase();
  if (BASENAME_MAP[baseName]) {
    return BASENAME_MAP[baseName];
  }
  const ext = getLowerExtension(relativePath);
  if (ext && EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }
  return { id: 'plaintext', label: 'Plain Text' };
}
