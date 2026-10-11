import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mirrorCodexRules, mirrorUserCodexConfig, parseCodexUserConfig, readCodexHostConfig, readCodexUserConfig,
  resolveCodexPermissions, resolveProjectDocFallbackFilenames, withoutNativePermissions,
} from '../src/user-config.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-user-config-'))
  roots.push(root)
  const storage = join(root, 'session-home')
  const userCodex = join(root, 'codex')
  await mkdir(storage, { recursive: true })
  await mkdir(userCodex, { recursive: true })
  return { root, storage, userCodex }
}

const nativeToml = `
model = "gpt-6.1-sol"
approval_policy = "never"
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto_review"
project_doc_fallback_filenames = ["CLAUDE.md", "GEMINI.md"]

[sandbox_workspace_write]
network_access = true
writable_roots = ["/data"]

[projects."/workspace"]
trust_level = "trusted"

[mcp_servers.node_repl]
command = "/usr/bin/node"
`

describe('readCodexUserConfig', () => {
  it('reads native permission, trust, and project-document settings', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), nativeToml)

    const native = await readCodexUserConfig(userCodex)

    expect(native).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      approvalsReviewer: 'auto_review',
      projectDocFallbackFilenames: ['CLAUDE.md', 'GEMINI.md'],
    })
  })

  it('keeps model, provider, and MCP configuration out of the session mirror', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), nativeToml)

    const native = await readCodexUserConfig(userCodex)

    expect(Object.keys(native.mirror ?? {}).sort()).toEqual([
      'approval_policy', 'approvals_reviewer', 'project_doc_fallback_filenames', 'projects',
      'sandbox_mode', 'sandbox_workspace_write',
    ])
    expect(native.mirror).not.toHaveProperty('model')
    expect(native.mirror).not.toHaveProperty('mcp_servers')
  })

  it('leaves every permission decision to the session preset when the host file is absent', async () => {
    const { userCodex } = await layout()

    await expect(readCodexUserConfig(userCodex)).resolves.toEqual({})
  })

  it('tolerates a machine that never had a ~/.codex directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-user-config-'))
    roots.push(root)
    const storage = join(root, 'session-home')

    await expect(readCodexUserConfig(join(root, 'missing', '.codex'))).resolves.toEqual({})
    await expect(mirrorUserCodexConfig(storage, {})).resolves.toBeUndefined()
  })

  it('fails loudly on malformed native settings', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), 'approval_policy = ')

    await expect(readCodexUserConfig(userCodex)).rejects.toThrow(/malformed/)
  })

  it('rejects a native permission value it cannot apply', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), 'sandbox_mode = "permissive"\n')

    await expect(readCodexUserConfig(userCodex)).rejects.toThrow()
  })
})

describe('mirrorUserCodexConfig', () => {
  it('writes only the native settings that decide permissions into the session home', async () => {
    const { storage, userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), nativeToml)

    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))

    const mirrored = await readFile(join(storage, 'config.toml'), 'utf8')
    expect(mirrored).toContain('approval_policy = "never"')
    expect(mirrored).toContain('sandbox_mode = "danger-full-access"')
    expect(mirrored).toContain('network_access = true')
    expect(mirrored).toContain('trust_level = "trusted"')
    expect(mirrored).not.toContain('gpt-6.1-sol')
    expect(mirrored).not.toContain('mcp_servers')
  })

  it('refreshes the mirror when the native settings change', async () => {
    const { storage, userCodex } = await layout()
    const source = join(userCodex, 'config.toml')
    await writeFile(source, 'approval_policy = "on-request"\n')
    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))
    await writeFile(source, 'approval_policy = "never"\n')

    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))

    expect(await readFile(join(storage, 'config.toml'), 'utf8')).toContain('approval_policy = "never"')
  })

  it('removes a stale mirror when the host sets no applicable setting', async () => {
    const { storage, userCodex } = await layout()
    const source = join(userCodex, 'config.toml')
    await writeFile(source, 'approval_policy = "never"\n')
    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))
    await writeFile(source, 'model = "gpt-6.1-sol"\n')

    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))

    await expect(readFile(join(storage, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves workspace trust the native runtime recorded itself', async () => {
    const { storage, userCodex } = await layout()
    await writeFile(join(storage, 'config.toml'), '[projects."/runtime-workspace"]\ntrust_level = "trusted"\n')
    await writeFile(join(userCodex, 'config.toml'), 'approval_policy = "never"\n\n[projects."/host-workspace"]\ntrust_level = "trusted"\n')

    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))

    const mirrored = await readFile(join(storage, 'config.toml'), 'utf8')
    expect(mirrored).toContain('approval_policy = "never"')
    expect(mirrored).toContain('/runtime-workspace')
    expect(mirrored).toContain('/host-workspace')
  })

  it('keeps the host entry for a workspace both the host and the runtime name', async () => {
    const { storage, userCodex } = await layout()
    await writeFile(join(storage, 'config.toml'), '[projects."/workspace"]\ntrust_level = "untrusted"\n')
    await writeFile(join(userCodex, 'config.toml'), '[projects."/workspace"]\ntrust_level = "trusted"\n')

    await mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))

    const mirrored = await readFile(join(storage, 'config.toml'), 'utf8')
    expect(mirrored).toContain('trust_level = "trusted"')
    expect(mirrored).not.toContain('untrusted')
  })

  it('fails loudly instead of overwriting a malformed session configuration', async () => {
    const { storage, userCodex } = await layout()
    await writeFile(join(storage, 'config.toml'), 'projects = ')
    await writeFile(join(userCodex, 'config.toml'), 'approval_policy = "never"\n')

    await expect(mirrorUserCodexConfig(storage, await readCodexUserConfig(userCodex))).rejects.toThrow(/malformed/)
  })
})

describe('withoutNativePermissions', () => {
  it('keeps workspace trust and project-document sources while dropping permission fields', () => {
    const native = parseCodexUserConfig(nativeToml, 'config.toml')

    const reduced = withoutNativePermissions(native)

    expect(reduced.approvalPolicy).toBeUndefined()
    expect(reduced.sandboxMode).toBeUndefined()
    expect(reduced.approvalsReviewer).toBeUndefined()
    expect(reduced.projectDocFallbackFilenames).toEqual(['CLAUDE.md', 'GEMINI.md'])
    expect(reduced.mirror).toEqual({
      project_doc_fallback_filenames: ['CLAUDE.md', 'GEMINI.md'],
      projects: { '/workspace': { trust_level: 'trusted' } },
    })
  })

  it('leaves no mirror at all when only permission settings existed', () => {
    const reduced = withoutNativePermissions(parseCodexUserConfig('approval_policy = "never"\n', 'config.toml'))

    expect(reduced.mirror).toBeUndefined()
  })
})

describe('resolveCodexPermissions', () => {
  const preset = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const

  it('applies the session preset when the host config decides nothing', () => {
    expect(resolveCodexPermissions(undefined, preset)).toEqual(preset)
    expect(resolveCodexPermissions({}, preset)).toEqual(preset)
  })

  it('lets each native field override the preset and fills only the gaps', () => {
    expect(resolveCodexPermissions({ sandboxMode: 'read-only', approvalPolicy: 'never' }, preset)).toEqual({
      sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
    })
    expect(resolveCodexPermissions({ approvalsReviewer: 'auto_review' }, preset)).toEqual({
      sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    })
  })
})

describe('resolveProjectDocFallbackFilenames', () => {
  it('prefers the native list and otherwise applies the deployment default', () => {
    expect(resolveProjectDocFallbackFilenames(undefined, ['CLAUDE.md'])).toEqual(['CLAUDE.md'])
    expect(resolveProjectDocFallbackFilenames(['AGENTS.local.md'], ['CLAUDE.md'])).toEqual(['AGENTS.local.md'])
    expect(resolveProjectDocFallbackFilenames(undefined, [])).toEqual([])
  })
})

describe('readCodexHostConfig', () => {
  it('reads the config settings and every verbatim rules file in name order', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), 'approval_policy = "never"\n')
    await mkdir(join(userCodex, 'rules'))
    await writeFile(join(userCodex, 'rules', 'z-deny.rules'), 'deny("rm")\n')
    await writeFile(join(userCodex, 'rules', 'a-allow.rules'), 'allow("ls")\n')
    await writeFile(join(userCodex, 'rules', 'notes.md'), 'not a rule')
    await mkdir(join(userCodex, 'rules', 'nested.rules'))

    const snapshot = await readCodexHostConfig(userCodex)

    expect(snapshot.config.approvalPolicy).toBe('never')
    expect(snapshot.rules).toEqual([
      { name: 'a-allow.rules', content: 'allow("ls")\n' },
      { name: 'z-deny.rules', content: 'deny("rm")\n' },
    ])
  })

  it('contributes nothing when the config file or the rules directory is absent', async () => {
    const { userCodex } = await layout()
    await writeFile(join(userCodex, 'config.toml'), 'sandbox_mode = "read-only"\n')

    await expect(readCodexHostConfig(userCodex)).resolves.toEqual({
      config: { sandboxMode: 'read-only', mirror: { sandbox_mode: 'read-only' } }, rules: [],
    })

    await rm(join(userCodex, 'config.toml'))
    const snapshot = await readCodexHostConfig(join(userCodex, 'missing'))
    expect(snapshot).toEqual({ config: {}, rules: [] })
  })

  it('keeps the snapshot unchanged after the host files change', async () => {
    const { userCodex } = await layout()
    const config = join(userCodex, 'config.toml')
    const rule = join(userCodex, 'rules', 'deny.rules')
    await writeFile(config, 'approval_policy = "never"\n')
    await mkdir(join(userCodex, 'rules'))
    await writeFile(rule, 'deny("rm")\n')
    const snapshot = await readCodexHostConfig(userCodex)

    await writeFile(config, 'approval_policy = "on-request"\n')
    await writeFile(rule, 'deny("everything")\n')

    expect(snapshot.config.approvalPolicy).toBe('never')
    expect(snapshot.rules).toEqual([{ name: 'deny.rules', content: 'deny("rm")\n' }])
  })
})

describe('mirrorCodexRules', () => {
  it('writes rule files verbatim and refreshes changed content', async () => {
    const { storage } = await layout()

    await mirrorCodexRules(storage, [{ name: 'deny.rules', content: 'deny("rm")\n' }])
    await mirrorCodexRules(storage, [{ name: 'deny.rules', content: 'deny("curl")\n' }])

    expect(await readFile(join(storage, 'rules', 'deny.rules'), 'utf8')).toBe('deny("curl")\n')
  })

  it('removes stale mirrored rules and clears the directory for an empty list', async () => {
    const { storage } = await layout()
    await mirrorCodexRules(storage, [
      { name: 'deny.rules', content: 'deny("rm")\n' }, { name: 'allow.rules', content: 'allow("ls")\n' },
    ])

    await mirrorCodexRules(storage, [{ name: 'deny.rules', content: 'deny("rm")\n' }])
    expect(await readdir(join(storage, 'rules'))).toEqual(['deny.rules'])

    await mirrorCodexRules(storage, [])
    expect(await readdir(join(storage, 'rules'))).toEqual([])
  })

  it('tolerates a session home without a rules directory', async () => {
    const { storage } = await layout()

    await expect(mirrorCodexRules(storage, [])).resolves.toBeUndefined()
    await expect(mirrorCodexRules(storage, [{ name: 'deny.rules', content: 'deny("rm")\n' }])).resolves.toBeUndefined()
    expect(await readFile(join(storage, 'rules', 'deny.rules'), 'utf8')).toBe('deny("rm")\n')
  })
})
