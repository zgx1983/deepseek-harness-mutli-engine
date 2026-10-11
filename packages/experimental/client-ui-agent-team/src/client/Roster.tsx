/** Shared roster grouping and member cards for Harness and engine-owned children. */
import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react'
import css from './TeamAction.module.css'

/**
 * Render populated status groups as single-column member lists.
 * @param props - Group labels, member values and their source-specific renderer.
 * @returns Status sections sharing native roster spacing and counts.
 */
export function RosterGroups<T>({ groups, renderItem }: {
  readonly groups: readonly { readonly key: string; readonly label: string; readonly items: readonly T[] }[]
  readonly renderItem: (item: T) => ReactNode
}) {
  return <>{groups.filter(group => group.items.length > 0).map(group => <section key={group.key}>
    <h3>{group.label} <span className={css.count}>{group.items.length}</span></h3>
    <div className={css.roster}>{group.items.map(renderItem)}</div>
  </section>)}</>
}

/**
 * Render the native member button with caller-owned identity and detail content.
 * @param props - Status marker, title, details and supported click operation.
 * @returns A reusable roster card without Session navigation assumptions.
 */
export const MemberCard = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  readonly marker: ReactNode
  readonly title: ReactNode
  readonly children: ReactNode
  readonly current?: boolean
  readonly expanded?: boolean
}>(function MemberCard({ marker, title, children, current, expanded, ...buttonProps }, ref) {
  return <button {...buttonProps} ref={ref} type="button"
    className={current ? `${css.member} ${css.memberCurrent}` : css.member}
    {...expanded === undefined ? {} : { 'aria-expanded': expanded }}>
    <span className={css.memberDot}>{marker}</span>
    <span className={css.memberText}><span className={css.memberName}>{title}</span>{children}</span>
  </button>
})
