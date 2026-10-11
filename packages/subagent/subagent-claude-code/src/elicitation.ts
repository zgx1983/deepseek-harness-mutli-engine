/** MCP elicitation projection onto the shared user-question service. */
import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'

const propertySchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
  enum: z.array(z.string()).optional(),
  items: z.object({ type: z.literal('string'), enum: z.array(z.string()) }).optional(),
}).loose()
const formSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), propertySchema),
  required: z.array(z.string()).optional(),
}).loose()
const contentSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))

/**
 * Render an MCP form or URL confirmation with turn-owned user questions.
 * @param request - SDK request with server text and a supported primitive form schema or HTTP(S) URL.
 * @param signal - owning turn and SDK request cancellation.
 * @param ask - scoped DSH answerer; its answers never outlive this request.
 * @returns validated form content, explicit URL confirmation, or a decline/cancellation.
 */
export async function answerClaudeElicitation(
  request: ElicitationRequest,
  signal: AbortSignal,
  ask: (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>,
): Promise<ElicitationResult> {
  signal.throwIfAborted()
  if (request.mode === 'url') {
    const parsed = z.url({ protocol: /^https?$/ }).safeParse(request.url)
    if (!parsed.success) return { action: 'decline' }
    const answer = await ask([{
      id: 'confirm', question: request.message, header: request.serverName,
      detail: parsed.data,
      options: [{ label: 'Continue' }, { label: 'Decline' }],
    }])
    signal.throwIfAborted()
    const reply = answer.answers.find(item => item.id === 'confirm')
    return { action: reply?.selected.length === 1 && reply.selected[0] === 'Continue' && !reply.custom
      ? 'accept' : 'decline' }
  }
  const parsed = formSchema.safeParse(request.requestedSchema)
  if (!parsed.success) return { action: 'decline' }
  const schema = parsed.data
  const fields = Object.entries(schema.properties)
  if (fields.some(([, field]) => field.format === 'password' || field.writeOnly === true
    || (field.type === 'array' && field.items === undefined))) return { action: 'decline' }
  let validator: z.ZodType
  try {
    const properties = new Map<string, z.core.JSONSchema.JSONSchema>()
    for (const [name, field] of fields) {
      const { title, description, format, enum: choices, items, ...rest } = field
      properties.set(name, {
        ...rest,
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
        ...format === undefined ? {} : { format },
        ...choices === undefined ? {} : { enum: choices },
        ...items === undefined ? {} : { items },
      })
    }
    const { required, properties: _properties, ...rest } = schema
    void _properties
    validator = z.fromJSONSchema({ ...rest, properties: Object.fromEntries(properties),
      ...required === undefined ? {} : { required } })
  } catch (error: unknown) {
    // Schema conversion failures cannot produce an unvalidated response.
    void error
    return { action: 'decline' }
  }
  if (fields.length === 0) {
    const answer = await ask([{ id: 'confirm', question: request.message, header: request.serverName,
      options: [{ label: 'Continue' }, { label: 'Decline' }] }])
    signal.throwIfAborted()
    const reply = answer.answers.find(item => item.id === 'confirm')
    return reply?.selected.length === 1 && reply.selected[0] === 'Continue' && !reply.custom
      && validator.safeParse({}).success ? { action: 'accept', content: {} } : { action: 'decline' }
  }
  const questions: AskUserQuestionItem[] = fields.map(([name, field]) => {
    const choices = field.type === 'boolean' ? ['true', 'false']
      : field.type === 'array' ? field.items?.enum : field.enum
    return {
      id: name, question: field.title ?? name, header: request.serverName,
      detail: [request.message, field.description].filter(value => value !== undefined).join('\n\n'),
      ...choices === undefined ? {} : { options: choices.map(label => ({ label })) },
      ...field.type === 'array' ? { multiSelect: true } : {},
    }
  })
  const answer = await ask(questions)
  signal.throwIfAborted()
  const values = new Map<string, string | number | boolean | string[]>()
  const answered = new Set<string>()
  for (const reply of answer.answers) {
    const field = schema.properties[reply.id]
    if (!Object.hasOwn(schema.properties, reply.id) || field === undefined || answered.has(reply.id)) return { action: 'cancel' }
    answered.add(reply.id)
    if (field.type === 'array') {
      if (reply.custom) return { action: 'cancel' }
      if (reply.selected.length > 0 || schema.required?.includes(reply.id)) values.set(reply.id, reply.selected)
      continue
    }
    if (reply.selected.length > 1 || (reply.selected.length > 0 && reply.custom)) return { action: 'cancel' }
    const value = reply.custom ?? reply.selected[0]
    if (value === undefined || (value === '' && !schema.required?.includes(reply.id))) continue
    if (field.type === 'boolean') {
      if (value !== 'true' && value !== 'false') return { action: 'cancel' }
      values.set(reply.id, value === 'true')
    } else if (field.type === 'number' || field.type === 'integer') {
      if (value.trim() === '' || !Number.isFinite(Number(value))) return { action: 'cancel' }
      values.set(reply.id, Number(value))
    } else values.set(reply.id, value)
  }
  const content = Object.fromEntries(values)
  return validator.safeParse(content).success && contentSchema.safeParse(content).success
    ? { action: 'accept', content } : { action: 'cancel' }
}
