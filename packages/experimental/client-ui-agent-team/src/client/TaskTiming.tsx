/** Compact local timestamps and elapsed time shared by Team cards. */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Inputs for the first-start to latest-end elapsed interval. */
interface TimingProps {
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly running: boolean
  readonly t: TranslateNS<typeof NS>
}

/**
 * Render day/hour/minute timestamps and elapsed time, refreshing running intervals each minute.
 * Elapsed time includes gaps between runs because the first start is retained.
 * @param props - Persisted interval endpoints, current activity, and copy.
 * @returns Inline timing labels; no timing is shown without a recorded start.
 */
export function TaskTiming({ startedAt, endedAt, running, t }: TimingProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [running, startedAt])
  if (startedAt === undefined) return null
  const formatTime = (value: number): string => new Date(value).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const endpoint = running ? now : endedAt
  const minutes = endpoint === undefined ? undefined
    : Math.floor(Math.max(0, endpoint - startedAt) / 60_000)
  const duration = minutes === undefined ? undefined : minutes === 0 ? t('task.duration.lessThanMinute')
    : [Math.floor(minutes / 1440) > 0 ? t('task.duration.days', { count: Math.floor(minutes / 1440) }) : '',
      Math.floor(minutes % 1440 / 60) > 0 ? t('task.duration.hours', { count: Math.floor(minutes % 1440 / 60) }) : '',
      minutes % 60 > 0 ? t('task.duration.minutes', { count: minutes % 60 }) : ''].filter(Boolean).join(' ')
  return <>
    {<span>{t('task.startedAt')}: <time dateTime={new Date(startedAt).toISOString()}>{formatTime(startedAt)}</time></span>}
    {endedAt !== undefined && <span>{t('task.endedAt')}: <time dateTime={new Date(endedAt).toISOString()}>{formatTime(endedAt)}</time></span>}
    {duration !== undefined && <span>{t('task.duration')}: {duration}</span>}
  </>
}
