/** Personal dashboard Host routes over registered projects and session history. */
import { createDashboardReader } from './dashboard.js'

export const inject = ['connection', 'sessionQuery', 'workspaceRegistry']

/** Register the read-only, authenticated dashboard snapshot route. */
export function apply(ctx) {
  const readDashboard = createDashboardReader(ctx)
  const logger = ctx.logger('personal-assistant')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/personal-assistant/dashboard', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const url = new URL(request.url)
        const timeZone = url.searchParams.get('timeZone') ?? 'UTC'
        const fresh = url.searchParams.get('fresh') === 'true'
        try {
          // Intl validates the caller's IANA timezone before the reader scans history.
          new Intl.DateTimeFormat('en-US', { timeZone })
        } catch (error) {
          if (!(error instanceof RangeError)) throw error
          return Response.json({ error: { code: 'invalid-time-zone' } }, { status: 400 })
        }
        return Response.json(await readDashboard(timeZone, fresh))
      } catch (error) {
        logger.warn('Dashboard data could not be loaded: %s', String(error))
        return Response.json({ error: { code: 'dashboard-unavailable' } }, { status: 500 })
      }
    },
  }), 'personal-assistant: dashboard route')
}
