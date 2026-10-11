/** Prevent macOS idle sleep while DSH-owned Session work is active. */

export const name = 'dsh-keep-awake'
export const inject = ['agents', 'subprocess']

export function apply(ctx) {
  if (process.platform !== 'darwin') {
    ctx.logger.info('Keep Awake is available only on macOS')
    return
  }

  const active = new Set()
  const jobs = ctx.get('jobs')
  const terminals = ctx.get('terminalController')
  let awakeProcess
  let disposed = false
  let reconcile = Promise.resolve()

  function setActivity(key, busy) {
    const wasBusy = active.size > 0
    if (busy) active.add(key)
    else active.delete(key)
    if (wasBusy !== (active.size > 0) || (active.size > 0 && awakeProcess === undefined)) queueReconcile()
  }

  function queueReconcile() {
    reconcile = reconcile.then(async () => {
      if ((active.size > 0) && !disposed && awakeProcess === undefined) {
        const executable = await ctx.subprocess.resolveExecutable('/usr/bin/caffeinate')
        const handle = ctx.subprocess.spawn({
          argv: [executable, '-i', '-w', String(process.pid)],
          cwd: process.cwd(),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 1024 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 1000,
        })
        awakeProcess = handle
        void handle.done.then(({ exitCode, signal }) => {
          if (awakeProcess !== handle) return
          awakeProcess = undefined
          if (!disposed) {
            const stderr = handle.collected.stderr?.readFrom(0).text.trim()
            ctx.logger.warn(`Keep Awake process exited (${signal ?? exitCode})${stderr ? `: ${stderr}` : ''}`)
          }
        }).catch((error) => {
          if (awakeProcess !== handle) return
          awakeProcess = undefined
          if (!disposed) ctx.logger.warn('Keep Awake process failed', error)
        })
      }

      if ((active.size === 0 || disposed) && awakeProcess !== undefined) {
        const handle = awakeProcess
        awakeProcess = undefined
        handle.terminate()
        await handle.waitForExit()
      }
    }).catch((error) => {
      ctx.logger.error('Keep Awake state could not be reconciled', error)
    })
  }

  for (const agent of ctx.agents.list()) {
    setActivity(`agent:${agent.id}`, agent.status === 'running')
  }
  for (const sessionId of terminals?.busySessions?.() ?? []) {
    setActivity(`terminal:${sessionId}`, true)
  }
  if (jobs !== undefined) {
    for (const agent of ctx.agents.list()) {
      for (const job of jobs.list(agent.id)) {
        if (job.owner === agent.id && (job.status === 'running' || job.status === 'stopping')) {
          setActivity(`job:${job.id}`, true)
        }
      }
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    setActivity(`agent:${agent.id}`, status === 'running')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    setActivity(`agent:${agent.id}`, false)
  })
  ctx.on('terminal/activity', (sessionId, busy) => {
    setActivity(`terminal:${sessionId}`, busy)
  })
  if (jobs !== undefined) {
    ctx.effect(() => jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'output' || event.job.owner === undefined) return
      const busy = event.type !== 'settled' && event.type !== 'removed'
      setActivity(`job:${event.job.id}`, busy)
    }), 'keep-awake.jobs')
  }

  ctx.effect(() => async () => {
    disposed = true
    active.clear()
    queueReconcile()
    await reconcile
  }, 'keep-awake.process')
}
