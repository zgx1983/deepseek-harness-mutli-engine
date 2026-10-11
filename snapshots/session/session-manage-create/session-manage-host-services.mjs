// Headless snapshot stub: the shipped FileUploads service is a Web connection
// service, so the keyless headless composition provides its one construction
// callback directly.
export const name = 'session-manage-file-uploads'

export function apply(ctx) {
  ctx.provide('fileUploads', {
    registerAgentResolver: (_resolver) => undefined,
  })
}
