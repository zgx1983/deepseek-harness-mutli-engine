/** Changed runtime libraries invalidate transitive consumers across dependency declarations. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { affectedBuildPackages, compilerBuildProjects } from './local-build-plan.ts'

it('includes changed packages, consumers and transitive consumers without rebuilding unrelated packages', () => {
  const packages = [
    { name: 'shared', directory: 'packages/core/shared', dependencies: [] },
    { name: 'ui', directory: 'packages/client/ui', dependencies: ['shared'] },
    { name: 'web', directory: 'apps/web', dependencies: ['ui'] },
    { name: 'desktop', directory: 'apps/desktop', dependencies: ['shared'] },
    { name: 'plugin', directory: 'plugins/plugin', dependencies: ['ui'] },
    { name: 'other', directory: 'packages/util/other', dependencies: [] },
  ]
  expect([...affectedBuildPackages(packages, ['shared'])].sort()).toEqual(['desktop', 'plugin', 'shared', 'ui', 'web'])
})

it('settles cyclic workspace dependencies and does not invent work without changes', () => {
  const packages = [
    { name: 'a', directory: 'packages/core/a', dependencies: ['b'] },
    { name: 'b', directory: 'packages/core/b', dependencies: ['a'] },
  ]
  expect([...affectedBuildPackages(packages, ['a'])].sort()).toEqual(['a', 'b'])
  expect(affectedBuildPackages(packages, [])).toEqual(new Set())
})

it('selects face-specific leaf configs from the existing aggregate instead of the solution root', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh-local-projects-'))
  try {
    mkdirSync(resolve(root, 'packages/a'), { recursive: true })
    mkdirSync(resolve(root, 'packages/b'), { recursive: true })
    for (const face of ['host', 'client']) {
      writeFileSync(resolve(root, `tsconfig.${face}.json`), JSON.stringify({ references: [
        { path: `./packages/a/tsconfig.${face}.json` },
      ] }))
      writeFileSync(resolve(root, `packages/a/tsconfig.${face}.json`), JSON.stringify({ references: [
        { path: '../b' },
      ] }))
    }
    writeFileSync(resolve(root, 'packages/b/tsconfig.json'), '{}')
    expect(compilerBuildProjects(root, 'tsconfig.host.json', ['packages/a']))
      .toEqual([resolve(root, 'packages/a/tsconfig.host.json')])
    expect(compilerBuildProjects(root, 'tsconfig.client.json', ['packages/a', 'packages/b']))
      .toEqual([resolve(root, 'packages/a/tsconfig.client.json'), resolve(root, 'packages/b/tsconfig.json')])
    writeFileSync(resolve(root, 'packages/b/tsconfig.json'), '{"references":[{}]}')
    expect(() => compilerBuildProjects(root, 'tsconfig.host.json', ['packages/a'])).toThrow('invalid project reference')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
