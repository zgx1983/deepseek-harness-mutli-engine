/** Exact-model reasoning choices and execution-engine parameter mappings. */
import { impliedDefaultEffort, LlmError, ReasoningEffortId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'

/** Provider defaults or exact-model overrides for an execution engine. */
export interface EngineReasoningOptions {
  /** Selectable ids mapped to engine parameter values; null disables thinking. */
  reasoningEfforts?: Readonly<Record<string, string | null>>
  /** Selectable default id; omitted to inherit the model default when supported. */
  defaultReasoningEffort?: string
}

/**
 * Resolve one engine's choices from model metadata and deployment mappings. A
 * default that neither the deployment nor the adapter named falls to the
 * strongest offered `xhigh`, `high` id, which is where these engines land.
 * @param source - native adapter reasoning metadata.
 * @param options - configured engine mappings for this exact model.
 * @param accepts - native engine parameter validation.
 * @param disabledValue - parameter that disables thinking in this engine.
 * @returns supported choices and a validated default, or undefined when none are offered.
 */
export function mapEngineReasoning(
  source: LlmModelReasoningInfo | undefined,
  options: EngineReasoningOptions,
  accepts: (value: string) => boolean,
  disabledValue: string | null,
): LlmModelReasoningInfo | undefined {
  const configured = options.reasoningEfforts
  const rows = configured === undefined
    ? source?.efforts ?? []
    : Object.entries(configured).map(([id, wireValue]) => {
      if (id.trim().length === 0) throw new Error('Engine reasoning ids must not be empty')
      const metadata = source?.efforts.find(effort => effort.id === id)
      return { ...metadata, id: ReasoningEffortId(id), name: metadata?.name ?? id, wireValue }
    })
  const efforts = rows.flatMap((effort) => {
    const declared = effort.wireValue === undefined ? effort.id === 'off' ? null : effort.id : effort.wireValue
    const wireValue = declared === null ? disabledValue : declared
    if (wireValue !== null && !accepts(wireValue)) {
      if (configured !== undefined) throw new Error(`Unsupported engine reasoning mapping "${effort.id}" -> "${wireValue}"`)
      return []
    }
    return [{ ...effort, wireValue }]
  })
  const wanted = options.defaultReasoningEffort ?? source?.defaultEffort
  const declared = efforts.find(effort => effort.id === wanted)?.id
  if (options.defaultReasoningEffort !== undefined && declared === undefined) {
    throw new Error(`Engine default reasoning effort "${options.defaultReasoningEffort}" is not offered`)
  }
  if (efforts.length === 0) return undefined
  const defaultEffort = declared ?? impliedDefaultEffort(efforts)
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/**
 * Validate a selected id and resolve its execution-engine parameter.
 * @param reasoning - engine-compatible choices for the exact provider/model.
 * @param selected - explicit selectable id, or undefined for the resolved default.
 * @returns native wire value, null for disabled thinking, or undefined for engine defaults.
 */
export function resolveEngineEffort(reasoning: LlmModelReasoningInfo | undefined, selected?: string): string | null | undefined {
  const id = selected ?? reasoning?.defaultEffort
  if (id === undefined) return undefined
  const effort = reasoning?.efforts.find(value => value.id === id)
  if (effort === undefined) throw new LlmError(`Selected engine does not support reasoning effort "${id}" for this model`, 'UNSUPPORTED_REASONING_EFFORT')
  return effort.wireValue === undefined ? effort.id : effort.wireValue
}
