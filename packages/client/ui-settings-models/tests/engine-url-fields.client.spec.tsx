// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { EngineUrlFields } from '../src/client/EngineUrlFields.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

it.each([['en', en], ['zh', zh]] as const)('records optional engine endpoint copy in %s', async (locale, copy) => {
  const { container } = render(<EngineUrlFields
    values={{ claudeCodeURL: '', codexURL: '' }}
    disabled={false}
    t={key => copy[key]}
    onChange={() => {}}
  />)
  const fields = screen.getAllByRole<HTMLInputElement>('textbox').map(input => ({
    label: input.getAttribute('aria-label'), placeholder: input.placeholder, value: input.value,
  }))
  await expect(JSON.stringify({ fields, text: container.textContent }, null, 2) + '\n')
    .toMatchFileSnapshot(`./expected/engine-endpoints-${locale}.txt`)
})
