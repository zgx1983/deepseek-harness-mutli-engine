/**
 * dsh-recent-sessions 构建：把 src/client.jsx 打包成 __ModuleLoader__ 闭包
 * 工厂格式的 lib/client.js（与 dsh-personal-assistant 同格式）。浏览器组件配合无行为的 Host 加载入口。
 *
 * 零安装：esbuild 不经本目录安装，而是经 packages/boot/hmr 解析；本目录
 * 位于仓库内，Node 向上查找即命中仓库 node_modules。
 */
import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const localRequire = createRequire(import.meta.url)
const esbuild = localRequire(resolveVia('packages/boot/hmr', 'esbuild'))

/** 经声明了对应依赖的 harness 包解析模块位置（pnpm 不提底座传递依赖）。 */
function resolveVia(anchorPkg, specifier) {
  const anchor = createRequire(join(repoRoot, anchorPkg, 'package.json'))
  return anchor.resolve(specifier)
}

await rm(join(here, 'lib'), { recursive: true, force: true })
await mkdir(join(here, 'lib'), { recursive: true })

await esbuild.build({
  entryPoints: [join(here, 'src', 'index.js')],
  outfile: join(here, 'lib', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
})

await esbuild.build({
  entryPoints: [join(here, 'src', 'client.jsx')],
  outfile: join(here, 'lib', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-dom/client',
    '@deepseek-ai/*',
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  banner: {
    js: "window.__ModuleLoader__.load({ id: '@deepseek-ai/dsh-client-ui-recent-sessions', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log('built lib/index.js + lib/client.js')
