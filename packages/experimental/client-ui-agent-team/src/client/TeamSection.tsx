/** Shared collapsible area behind the Team dashboard regions and the header panel. */
import { useId, useRef, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TeamAction.module.css'

/** One foldable Team section: header stays visible, only the body folds away. */
export interface TeamSectionProps {
  readonly title: string
  /** Total shown beside the title, computed from the whole area regardless of folds. */
  readonly count?: number
  /** Short status segments shown in the header while expanded or collapsed. */
  readonly summary?: readonly string[]
  readonly expanded: boolean
  readonly onToggle: (expanded: boolean) => void
  /** Header controls beside the title, e.g. expand-all and collapse-all actions. */
  readonly actions?: ReactNode
  /** `area` renders an h3 section header, `group` a nested h4 header. */
  readonly level?: 'area' | 'group'
  readonly bodyClassName?: string
  readonly children: ReactNode
}

/**
 * Render one collapsible Team region with an accessible header toggle.
 * Collapsing keeps the header and its counts visible, moves focus out of the
 * hidden body back to the toggle, and removes the body from the tab order.
 * @param props - Header content, controlled fold state, and the body.
 * @returns The section with its toggle header and, when expanded, its body.
 */
export function TeamSection({
  title, count, summary, expanded, onToggle, actions, level = 'area', bodyClassName, children,
}: TeamSectionProps) {
  const bodyId = useId()
  const headerRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const Heading = level === 'area' ? 'h3' : 'h4'
  const toggle = (): void => {
    if (expanded && bodyRef.current?.contains(document.activeElement)) headerRef.current?.focus()
    onToggle(!expanded)
  }
  return <section className={level === 'area' ? css.section : css.groupSection}>
    <div className={css.sectionHeader}>
      <Heading>
        <button ref={headerRef} type="button" className={css.sectionToggle} aria-expanded={expanded}
          aria-controls={bodyId} onClick={toggle}>
          <IconChevronDownOutlineRegular size={12} aria-hidden
            className={expanded ? css.sectionArrow : `${css.sectionArrow} ${css.sectionArrowClosed}`} />
          <span className={css.sectionTitle}>{title}</span>
          {count !== undefined && <span className={css.count}>{count}</span>}
          {summary?.map(segment => <span key={segment} className={css.sectionSummary}>{segment}</span>)}
        </button>
      </Heading>
      {expanded && actions !== undefined && <div className={css.sectionActions}>{actions}</div>}
    </div>
    {expanded && <div ref={bodyRef} id={bodyId} className={bodyClassName}>{children}</div>}
  </section>
}
