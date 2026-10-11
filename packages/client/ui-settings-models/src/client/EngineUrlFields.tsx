/** Optional engine endpoints shared by provider creation and editing. */
import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Provider profile fields naming external engine endpoints. */
export type EngineUrlField = 'claudeCodeURL' | 'codexURL'

/** Input state and localized copy supplied by the owning form. */
interface EngineUrlFieldsProps {
  values: Record<EngineUrlField, string>
  placeholders?: Partial<Record<EngineUrlField, string | undefined>>
  disabled: boolean
  t: (key: keyof typeof en) => string
  onChange: (field: EngineUrlField, value: string) => void
}

/**
 * Render optional Claude Code and Codex URL inputs.
 * @param props - values, inherited placeholders, localization and draft updates.
 * @returns the two endpoint fields and their availability hints.
 */
export function EngineUrlFields(props: EngineUrlFieldsProps): ReactNode {
  return <>{(['claudeCodeURL', 'codexURL'] as const).map(field => (
    <div className={styles['field']} key={field}>
      <span className={styles['fieldLabel']}>{props.t(field)}</span>
      <input
        className={styles['input']}
        type="text"
        value={props.values[field]}
        placeholder={props.placeholders?.[field] ?? props.t('engineUrlUnset')}
        aria-label={props.t(field)}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(field, event.target.value) }}
      />
      <span className={styles['advancedHint']}>{props.t('engineUrlHint')}</span>
    </div>
  ))}</>
}
