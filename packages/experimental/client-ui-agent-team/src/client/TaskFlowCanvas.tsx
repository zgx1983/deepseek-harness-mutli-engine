/** Shared read-only SVG body of a task dependency flow graph. */
import { useId, type KeyboardEvent, type ReactNode, type SVGProps } from 'react'
import type { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {
  GraphEdge, TaskGraphLayout, TaskGraphNodeTask, Viewport,
} from './task-flow.ts'
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from './task-flow.ts'
import css from './TeamAction.module.css'

/** Presentation props of one flow-graph canvas; owners keep viewport and selection state. */
export interface TaskFlowCanvasProps<T extends TaskGraphNodeTask> {
  readonly layout: TaskGraphLayout<T>
  readonly viewport: Viewport
  readonly ariaLabel: string
  /** Copy for a read-only placeholder replacing an absent prerequisite. */
  readonly missingLabel: string
  readonly svgClassName: string | undefined
  /** Owner handlers on the svg element, such as canvas pan pointers. */
  readonly svgProps?: SVGProps<SVGSVGElement>
  readonly edgeClassName: (edge: GraphEdge) => string | undefined
  readonly edgeTitle: (edge: GraphEdge) => string
  /** Extra class per real-task node group; absent renders plain graphic groups. */
  readonly nodeClassName?: (task: T) => string | undefined
  readonly nodeAriaLabel: (task: T) => string
  readonly renderNodeMeta: (task: T) => ReactNode
  /** Node activation; when absent, nodes stay non-interactive. */
  readonly onNodeActivate?: (taskId: TeamTaskId) => void
}

/**
 * Render the layered flow as svg: one arrow per prerequisite edge, one box per
 * task, and dashed placeholders for missing prerequisites. Pure presentation —
 * pan, zoom, selection, and legend live with the owner.
 * @param props - Layout, viewport, and per-element presentation resolvers.
 * @returns The flow-graph svg.
 */
export function TaskFlowCanvas<T extends TaskGraphNodeTask>({
  layout, viewport, ariaLabel, missingLabel, svgClassName, svgProps,
  edgeClassName, edgeTitle, nodeClassName, nodeAriaLabel, renderNodeMeta, onNodeActivate,
}: TaskFlowCanvasProps<T>) {
  const markerId = useId()
  return (
    <svg className={svgClassName} role="group" aria-label={ariaLabel} {...svgProps}>
      <defs>
        <marker id={markerId} markerWidth="7" markerHeight="7" viewBox="0 0 10 10" refX="9" refY="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className={css.flowArrowHead} />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`}>
        {layout.edges.map((edge) => {
          const bend = Math.max(12, (edge.x2 - edge.x1) / 2)
          return <path key={`${edge.from}->${edge.to}`}
            className={edgeClassName(edge)}
            markerEnd={`url(#${markerId})`} fill="none"
            d={`M${edge.x1},${edge.y1} C${edge.x1 + bend},${edge.y1} ${edge.x2 - bend},${edge.y2} ${edge.x2},${edge.y2}`}>
            <title>{edgeTitle(edge)}</title>
          </path>
        })}
        {layout.nodes.map((node) => {
          if (node.task === undefined) {
            return <g key={node.id}>
              <rect className={css.flowNodeMissing} x={node.x} y={node.y} width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx={8} />
              <foreignObject x={node.x + 8} y={node.y + 6} width={GRAPH_NODE_WIDTH - 16} height={GRAPH_NODE_HEIGHT - 12}>
                <div className={css.flowNodeBody}>
                  <strong className={css.flowNodeTitle} title={node.id}>{node.id}</strong>
                  <span className={css.flowNodeMeta}>{missingLabel}</span>
                </div>
              </foreignObject>
            </g>
          }
          const task = node.task
          const activation = onNodeActivate === undefined ? {} : {
            role: 'button' as const, tabIndex: 0,
            onClick: () => { onNodeActivate(task.id) },
            onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onNodeActivate(task.id)
            },
          }
          return <g key={node.id}
            {...activation}
            aria-label={nodeAriaLabel(task)}
            className={nodeClassName?.(task)}>
            <rect className={css.flowNodeBox} x={node.x} y={node.y} width={GRAPH_NODE_WIDTH} height={GRAPH_NODE_HEIGHT} rx={8} />
            <foreignObject x={node.x + 8} y={node.y + 6} width={GRAPH_NODE_WIDTH - 16} height={GRAPH_NODE_HEIGHT - 12}>
              <div className={css.flowNodeBody}>
                <strong className={css.flowNodeTitle} title={task.subject}>{task.subject}</strong>
                <span className={css.flowNodeMeta}>{renderNodeMeta(task)}</span>
              </div>
            </foreignObject>
          </g>
        })}
      </g>
    </svg>
  )
}
