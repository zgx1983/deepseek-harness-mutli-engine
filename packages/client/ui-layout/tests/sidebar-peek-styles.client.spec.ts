import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const frameCss = readFileSync(fileURLToPath(new URL(
  '../src/client/AppFrame.module.css',
  import.meta.url,
)), 'utf8')

/** Return one stylesheet rule body for an exact selector. */
function rule(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }\\s*\\{([^}]*)\\}`, 's').exec(frameCss)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('sidebar preview styles', () => {
  it('keeps the previewed column a grid item overflowing its own track', () => {
    const peeked = rule('.frame[data-sidebar-peek] .sidebarCol[data-sidebar-col]')
    // An absolutely positioned column leaves the grid flow, and the centre column
    // then auto-places into the collapsed zero-width track: a blank conversation.
    expect(peeked).toContain('position: relative')
    expect(peeked).not.toContain('position: absolute')
    expect(peeked).not.toMatch(/\b(top|left|bottom):/)
  })

  it('lifts the preview above the centre and keeps its own edge', () => {
    const peeked = rule('.frame[data-sidebar-peek] .sidebarCol[data-sidebar-col]')
    expect(peeked).toMatch(/z-index:\s*17/)
    expect(peeked).toContain('var(--dsw-alias-bg-base)')
    expect(peeked).toContain('var(--dsw-elevation-panel)')
    expect(peeked).toMatch(/border-right:\s*0/)
  })

  it('keeps the edge trigger a pointer-only strip below the preview', () => {
    const hotspot = rule('.peekHotspot')
    expect(hotspot).toContain('position: absolute')
    expect(hotspot).toContain('z-index: 16')
    expect(hotspot).toContain('-webkit-app-region: no-drag')
    expect(hotspot).toContain('var(--dsh-frame-top-clearance, 0px)')
  })
})
