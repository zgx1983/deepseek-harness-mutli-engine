/** Pure display transforms behind the Team task groups and the dependency flow graph. */
import type {
  TeamMemberProjection, TeamTaskId, TeamTaskStatus, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'

/**
 * Resolve one task owner to its roster row. Roster names are immutable and
 * Team-unique, so an exact match is the owning member; an unclaimed task or a
 * name absent from the current roster resolves to nothing.
 * @param ownerName - Task owner name from the projection.
 * @param members - Current Team roster rows.
 * @returns the owning member row, or undefined without a reliable match.
 */
export function ownerMember(ownerName: string | undefined, members: readonly TeamMemberProjection[]): TeamMemberProjection | undefined {
  if (ownerName === undefined) return undefined
  return members.find(member => member.name === ownerName)
}

/**
 * Localized status label for one task view.
 * @param status - durable task status to translate.
 * @returns the locale key for that status.
 */
export function taskStatusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

/**
 * Status dot state for one task view: ready pending stays idle, blocked warns.
 * @param task - task view whose status and readiness feed the dot.
 * @returns the dot state matching the task's scheduling situation.
 */
export function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

/** Task board groups; waiting-for-dependency tasks stay inside `pending`. */
export type TaskGroupKey = 'in_progress' | 'pending' | 'completed'

/** Current task board partitioned for the folded task area. */
export interface TaskGrouping {
  readonly inProgress: readonly TeamTask[]
  readonly pending: readonly TeamTask[]
  readonly completed: readonly TeamTask[]
  /** Pending tasks whose unfinished prerequisites keep them from dispatch. */
  readonly waitingDependency: number
}

/**
 * Partition the current task board into the three display groups.
 * Deleted tasks never reach the client projection and are not handled here.
 * @param tasks - Current non-deleted task views in projection (creation) order.
 * @returns Grouped tasks plus the waiting-for-dependency count.
 */
export function groupTasks(tasks: readonly TeamTask[]): TaskGrouping {
  const inProgress: TeamTask[] = []
  const pending: TeamTask[] = []
  const completed: TeamTask[] = []
  let waitingDependency = 0
  for (const task of tasks) {
    if (task.status === 'in_progress') inProgress.push(task)
    else if (task.status === 'completed') completed.push(task)
    else {
      pending.push(task)
      if (!task.ready) waitingDependency += 1
    }
  }
  return { inProgress, pending, completed, waitingDependency }
}

/** Fixed node box; titles and metadata truncate inside the rendered node. */
export const GRAPH_NODE_WIDTH = 176
/** Fixed node box height; titles and metadata truncate inside the rendered node. */
export const GRAPH_NODE_HEIGHT = 54
/** Vertical gap between nodes in one dependency layer. */
export const GRAPH_LANE_GAP = 28
/** Horizontal gap between dependency depth layers of the flow graph. */
export const GRAPH_DEPTH_GAP = 46

/** Smallest and largest canvas scales, shared by fit and the zoom controls. */
export const GRAPH_MIN_SCALE = 0.2
export const GRAPH_MAX_SCALE = 4

/** Canvas transform: content-space pan offset plus uniform zoom. */
export interface Viewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/** Minimal task facts the flow layout draws; `TeamTaskView` satisfies it. */
export interface TaskGraphNodeTask {
  readonly id: TeamTaskId
  readonly subject: string
  readonly status: TeamTaskStatus
  readonly blockedBy: readonly TeamTaskId[]
}

/** One flow-graph node: a real task or a read-only placeholder for a missing prerequisite. */
export interface GraphNode<T extends TaskGraphNodeTask = TaskGraphNodeTask> {
  readonly id: TeamTaskId
  /** The task behind the node; absent for a missing-prerequisite placeholder. */
  readonly task?: T
  /** Layer index: the longest prerequisite chain; placeholders sit at depth 0. */
  readonly depth: number
  /** Stable position within the layer: creation order, placeholders after real tasks. */
  readonly lane: number
  /** Content-space box origin: x by dependency depth, y by lane (left-to-right flow). */
  readonly x: number
  readonly y: number
}

/** One prerequisite arrow from `from` into `to`, in content space. */
export interface GraphEdge {
  readonly from: TeamTaskId
  readonly to: TeamTaskId
  /** True once the prerequisite task is completed. */
  readonly satisfied: boolean
  /** Arrow start on the prerequisite box right edge and end on the task box left edge. */
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/** Layered read-only layout of the whole task graph. */
export interface TaskGraphLayout<T extends TaskGraphNodeTask = TaskGraphNodeTask> {
  readonly nodes: readonly GraphNode<T>[]
  readonly edges: readonly GraphEdge[]
  /** True when prerequisites form a cycle; the task list stays the authoritative view. */
  readonly cyclic: boolean
  /** Content-space bounding box of every node. */
  readonly width: number
  readonly height: number
}

/** Unpositioned node before the final depth-and-lane coordinate pass. */
type PlacedNode<T extends TaskGraphNodeTask> = Omit<GraphNode<T>, 'x' | 'y'>

/**
 * Compute the mount-time fit: content scaled down to the measured canvas and
 * centered, clamped to the shared scale range.
 * @param bounds - Measured canvas box.
 * @param contentWidth - Layout bounding width.
 * @param contentHeight - Layout bounding height.
 * @returns the identity viewport for an unmeasurable or empty canvas.
 */
export function fitViewport(
  bounds: { readonly width: number; readonly height: number },
  contentWidth: number,
  contentHeight: number,
): Viewport {
  const scale = Math.min(
    Math.max(Math.min(bounds.width / contentWidth, bounds.height / contentHeight, 1), GRAPH_MIN_SCALE),
    GRAPH_MAX_SCALE,
  )
  return {
    x: Math.max(0, (bounds.width - contentWidth * scale) / 2),
    y: Math.max(8, (bounds.height - contentHeight * scale) / 2),
    scale,
  }
}

/**
 * Layer the task graph for a left-to-right flow: depth is the longest
 * prerequisite chain, lanes stack within each layer in projection (creation)
 * order. Cycles are
 * reported instead of hanging the depth walk; no task or edge is dropped, and
 * prerequisites missing from the board become read-only placeholder nodes.
 * Every edge endpoint is a node by construction, so renderers never resolve ids.
 * @param tasks - Current non-deleted task views in projection order.
 * @returns Positioned nodes, positioned edges, the cycle flag, and the bounds.
 */
export function layoutTaskGraph<T extends TaskGraphNodeTask>(tasks: readonly T[]): TaskGraphLayout<T> {
  const byId = new Map<TeamTaskId, T>(tasks.map(task => [task.id, task]))
  const missing = new Set<TeamTaskId>()
  for (const task of tasks) {
    for (const prerequisite of task.blockedBy) {
      if (!byId.has(prerequisite)) missing.add(prerequisite)
    }
  }

  let cyclic = false
  const depthByNode = new Map<TeamTaskId, number>()
  const walking = new Set<TeamTaskId>()
  const nodeDepth = (task: T): number => {
    const memoized = depthByNode.get(task.id)
    if (memoized !== undefined) return memoized
    /* A guard-set hit means the walk re-entered this node through a cycle;
       reporting it and treating the back-edge as absent keeps layering finite. */
    if (walking.has(task.id)) {
      cyclic = true
      return 0
    }
    walking.add(task.id)
    let resolved = 0
    for (const prerequisite of task.blockedBy) {
      const source = byId.get(prerequisite)
      // A missing prerequisite renders as a depth-0 placeholder, so its
      // dependent still layers one to its right.
      resolved = Math.max(resolved, source === undefined ? 1 : nodeDepth(source) + 1)
    }
    walking.delete(task.id)
    depthByNode.set(task.id, resolved)
    return resolved
  }

  const nextLane = new Map<number, number>()
  const laneFor = (depth: number): number => {
    const lane = nextLane.get(depth) ?? 0
    nextLane.set(depth, lane + 1)
    return lane
  }

  const placed: PlacedNode<T>[] = []
  for (const task of tasks) {
    const depth = nodeDepth(task)
    placed.push({ id: task.id, task, depth, lane: laneFor(depth) })
  }
  for (const id of [...missing].sort()) placed.push({ id, depth: 0, lane: laneFor(0) })
  placed.sort((left, right) => left.depth - right.depth || left.lane - right.lane)
  const nodes: GraphNode<T>[] = placed.map(node => ({
    ...node,
    x: node.depth * (GRAPH_NODE_WIDTH + GRAPH_DEPTH_GAP),
    y: node.lane * (GRAPH_NODE_HEIGHT + GRAPH_LANE_GAP),
  }))

  const boxes = new Map(nodes.map(node => [node.id, node]))
  const edges: GraphEdge[] = []
  for (const task of tasks) {
    const target = boxes.get(task.id)
    for (const prerequisite of task.blockedBy) {
      const source = boxes.get(prerequisite)
      /* v8 ignore next 3 -- every edge endpoint lands in `boxes` above: the
         dependent is a task, and an unplaced prerequisite became a placeholder. */
      if (source === undefined || target === undefined) continue
      edges.push({
        from: prerequisite, to: task.id, satisfied: byId.get(prerequisite)?.status === 'completed',
        x1: source.x + GRAPH_NODE_WIDTH, y1: source.y + GRAPH_NODE_HEIGHT / 2,
        x2: target.x, y2: target.y + GRAPH_NODE_HEIGHT / 2,
      })
    }
  }
  return {
    nodes, edges, cyclic,
    width: nodes.length === 0 ? 0 : (Math.max(...nodes.map(node => node.depth)) + 1) * (GRAPH_NODE_WIDTH + GRAPH_DEPTH_GAP),
    height: nodes.length === 0 ? 0 : (Math.max(...nodes.map(node => node.lane)) + 1) * (GRAPH_NODE_HEIGHT + GRAPH_LANE_GAP),
  }
}
