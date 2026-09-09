import type { UserConfig } from 'tsdown'

const node: UserConfig = {
  entry: {
    index: 'src/index.ts',
    core: 'src/core/engine.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-jobs',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
}

const client: UserConfig = {
  name: '@dsh-external/dsh-dog/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-external/dsh-dog", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [node, client] satisfies UserConfig[]
