/**
 * EngineSelect: the composer's execution-engine seat (`conversation.input.engine`).
 * After the first user message locks the engine, only its static name is shown.
 */
import { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineSelectInjected } from './slots.ts'
import css from './EngineSelect.module.css'

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the composer engine seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store and verbs) + the standard locale seat.
 * @returns the trigger and, while open, the engine menu.
 */
export function EngineSelect(
  { locked, available, directory, load, select, t }:
  EngineSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const engine = state.engine
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const id = useId()

  const current = useMemo(
    () => engine.engines.find(candidate => candidate.id === engine.currentId),
    [engine.engines, engine.currentId],
  )
  const fixed = locked || engine.fixed
  const busy = engine.status === 'loading'
  const label = current?.name
    ?? (engine.currentId === null ? t('engine.triggerDefault') : engine.currentId)

  const reload = (): void => { load() }

  useEffect(() => {
    if (!open || fixed) return
    const closeOutside = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open, fixed])

  useLayoutEffect(() => {
    if (!open || fixed) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, engine, fixed])

  if (!available) return null
  if (fixed) return (
    <div className={css.root}>
      <span className={css.fixed} title={label}>{label}</span>
    </div>
  )

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const choose = (engineId: string): void => {
    if (engineId === (engine.currentId ?? 'native')) {
      close(true)
      return
    }
    triggerRef.current?.focus()
    void select(engineId).then((result) => {
      if (result === undefined || result.ok) close(true)
    })
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = active === -1
      ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={t('engine.triggerAria', { engine: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={label}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            setOpen(true)
            reload()
          }
        }}
      >
        <span className={css.triggerLabel}>{label}</span>
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={t('engine.menuAria')}
          aria-busy={engine.status === 'loading'}
        >
          {engine.error !== null && (
            <div className={css.error}>
              <span>{t('engine.error', { message: engine.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
            </div>
          )}
          <div className={clsx(css.options, 'scrollable')}>
            {engine.engines.map((entry) => {
              const selected = entry.id === (engine.currentId ?? 'native')
              return (
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={clsx(css.option, selected && css.selected)}
                  key={entry.id}
                  disabled={!selected && busy}
                  onClick={() => { choose(entry.id) }}
                >
                  <span className={css.optionCopy}>
                    <span className={css.engineName}>{entry.name}</span>
                    {entry.description !== undefined && <span className={css.engineDescription}>{entry.description}</span>}
                  </span>
                  <span className={css.check}>
                    {selected ? <IconCheckOutlineRegular /> : null}
                  </span>
                </button>
              )
            })}
          </div>
          {engine.status === 'ready' && engine.engines.length === 0 && (
            <div className={css.empty}>{t('engine.empty')}</div>
          )}
        </MenuSurface>,
        document.body,
      )}
    </div>
  )
}
