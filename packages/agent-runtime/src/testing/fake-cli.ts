import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

export const Step = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('say'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
    output: z.string().default(''),
    writes: z.object({ path: z.string(), content: z.string() }).optional(),
    id: z.string().optional(),
    dropMeta: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('park'), name: z.string() }),
  z.object({ kind: z.literal('hang') }),
  z.object({ kind: z.literal('cancelQueued') }),
  z.object({ kind: z.literal('crash'), code: z.number() }),
])
export type Step = z.input<typeof Step>

const Finish = z.object({
  isError: z.boolean().default(false),
  subtype: z.string().optional(),
  terminalReason: z.string().optional(),
  text: z.string().optional(),
})

const Phase = z.object({
  steps: z.array(Step).default([]),
  finish: Finish.default(Finish.parse({})),
})

export const Script = z.object({
  first: Phase.default(Phase.parse({})),
  next: Phase.default(Phase.parse({})),
})
export type Script = z.input<typeof Script>

class Aborted extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const Incoming = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  priority: z.unknown().optional(),
  message: z.looseObject({ content: z.unknown().optional() }).optional(),
  request_id: z.string().optional(),
  request: z
    .looseObject({
      subtype: z.string(),
      hooks: z
        .looseObject({
          PreToolUse: z
            .array(z.looseObject({ hookCallbackIds: z.array(z.string()).default([]) }))
            .default([]),
        })
        .optional(),
      sdkMcpServers: z.array(z.string()).optional(),
      cancel_queued: z.boolean().optional(),
    })
    .optional(),
  response: z.looseObject({ request_id: z.string() }).optional(),
})

const HookReply = z.looseObject({
  subtype: z.string().optional(),
  response: z
    .looseObject({
      decision: z.string().optional(),
      hookSpecificOutput: z.looseObject({ permissionDecision: z.string().optional() }).optional(),
    })
    .optional(),
})

const McpReply = z.looseObject({
  response: z
    .looseObject({
      mcp_response: z
        .looseObject({
          result: z
            .looseObject({ content: z.unknown().optional(), isError: z.boolean().optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

const script = Script.parse(JSON.parse(process.env['FAKE_CLI_SCRIPT'] ?? '{}'))
const signalDir = process.env['FAKE_CLI_SIGNAL_DIR'] ?? ''
const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? ''
const cwd = process.cwd()
const args = process.argv.slice(2)
const resumeFlag = args.findIndex((a) => a === '--resume' || a.startsWith('--resume='))
const resumeId =
  resumeFlag < 0 ? undefined : (args[resumeFlag]?.split('=')[1] ?? args[resumeFlag + 1])
const sessionId = resumeId ?? crypto.randomUUID()
const projectsDir = join(configDir, 'projects')
const projectDir = join(projectsDir, cwd.replaceAll(/[^a-zA-Z0-9]/g, '-'))
const transcriptPath = join(projectDir, `${sessionId}.jsonl`)

type Queued = { uuid: string; priority: unknown; content: unknown }

const state = {
  queue: [] as Queued[],
  wake: undefined as (() => void) | undefined,
  inputClosed: false,
  interrupted: false,
  exiting: false,
  running: undefined as AbortController | undefined,
  hookCallbackId: undefined as string | undefined,
  currentToolUseId: undefined as string | undefined,
  mcpId: 1,
  pending: new Map<string, (reply: unknown) => void>(),
}

const out = (msg: Record<string, unknown>) => void process.stdout.write(`${JSON.stringify(msg)}\n`)

const exit = (code: number) => {
  state.exiting = true
  process.stdout.write('', () => process.exit(code))
}

const stamp = () => ({ session_id: sessionId, uuid: crypto.randomUUID() })

const record = (row: Record<string, unknown>) => {
  mkdirSync(projectDir, { recursive: true })
  appendFileSync(transcriptPath, `${JSON.stringify({ ...row, sessionId })}\n`)
}

const lifecycle = (commandUuid: string, lifecycleState: string) =>
  out({ type: 'command_lifecycle', command_uuid: commandUuid, state: lifecycleState, ...stamp() })

const request = (body: Record<string, unknown>, signal: AbortSignal) =>
  new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID()
    state.pending.set(requestId, resolve)
    signal.addEventListener(
      'abort',
      () => {
        state.pending.delete(requestId)
        reject(new Aborted())
      },
      { once: true },
    )
    out({ type: 'control_request', request_id: requestId, request: body })
  })

const waitForFile = async (path: string, signal: AbortSignal) => {
  while (!existsSync(path)) {
    if (signal.aborted) throw new Aborted()
    await sleep(5)
  }
}

const assistant = (content: unknown[]) => {
  const { uuid, session_id } = stamp()
  record({ type: 'assistant', uuid, message: { role: 'assistant', content } })
  out({
    type: 'assistant',
    message: {
      model: 'fake-cli',
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: null,
      stop_sequence: null,
    },
    parent_tool_use_id: null,
    session_id,
    uuid,
  })
}

const toolResult = (
  toolUseId: string,
  content: unknown,
  isError: boolean,
  meta?: Record<string, unknown>,
) => {
  const { uuid, session_id } = stamp()
  const message = {
    role: 'user',
    content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }],
  }
  record({ type: 'user', uuid, message })
  out({
    type: 'user',
    message,
    parent_tool_use_id: null,
    session_id,
    uuid,
    ...(meta === undefined ? {} : { tool_result_meta: [{ id: toolUseId, ...meta }] }),
  })
}

const callMcpTool = async (
  name: string,
  input: Record<string, unknown>,
  toolUseId: string,
  dropMeta: boolean,
  signal: AbortSignal,
) => {
  const [, server, ...tool] = name.split('__')
  const id = ++state.mcpId
  const reply = await request(
    {
      subtype: 'mcp_message',
      server_name: server,
      message: {
        method: 'tools/call',
        params: {
          name: tool.join('__'),
          arguments: input,
          ...(dropMeta ? {} : { _meta: { 'claudecode/toolUseId': toolUseId, progressToken: id } }),
        },
        jsonrpc: '2.0',
        id,
      },
    },
    signal,
  )
  return McpReply.parse(reply).response?.mcp_response?.result
}

const hookAllows = async (
  step: { name: string; input: Record<string, unknown> },
  toolUseId: string,
  signal: AbortSignal,
) => {
  if (state.hookCallbackId === undefined) return true
  const reply = HookReply.parse(
    await request(
      {
        subtype: 'hook_callback',
        callback_id: state.hookCallbackId,
        input: {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          permission_mode: 'bypassPermissions',
          hook_event_name: 'PreToolUse',
          tool_name: step.name,
          tool_input: step.input,
          tool_use_id: toolUseId,
        },
        tool_use_id: toolUseId,
      },
      signal,
    ),
  )
  return (
    reply.subtype === 'success' &&
    reply.response?.decision !== 'block' &&
    (reply.response?.hookSpecificOutput?.permissionDecision ?? 'allow') === 'allow'
  )
}

const runTool = async (
  step: Extract<z.output<typeof Step>, { kind: 'tool' }>,
  signal: AbortSignal,
) => {
  const toolUseId = step.id ?? `toolu_${crypto.randomUUID().replaceAll('-', '')}`
  state.currentToolUseId = toolUseId
  assistant([
    {
      type: 'tool_use',
      id: toolUseId,
      name: step.name,
      input: step.input,
      caller: { type: 'direct' },
    },
  ])
  const allowed = await hookAllows(step, toolUseId, signal)
  const meta = {
    permission_decision: {
      decision: allowed ? 'accept' : 'deny',
      source: 'hook',
      reason_type: 'hook',
    },
  }
  if (!allowed) {
    state.currentToolUseId = undefined
    return toolResult(toolUseId, 'The PreToolUse hook denied this tool use.', true, meta)
  }
  if (step.name.startsWith('mcp__')) {
    const result = await callMcpTool(step.name, step.input, toolUseId, step.dropMeta, signal)
    state.currentToolUseId = undefined
    return toolResult(toolUseId, result?.content ?? [], result?.isError ?? false, meta)
  }
  if (step.writes) writeFileSync(join(cwd, step.writes.path), step.writes.content)
  state.currentToolUseId = undefined
  toolResult(toolUseId, step.output, false, meta)
}

const result = (fields: Record<string, unknown>, userUuid: string, numTurns: number) =>
  out({
    type: 'result',
    is_error: false,
    num_turns: numTurns,
    duration_ms: 0,
    total_cost_usd: 0,
    permission_denials: [],
    user_message_uuid: userUuid,
    user_message_uuids: [userUuid],
    ...fields,
    ...stamp(),
  })

const runSteps = async (steps: z.output<typeof Step>[], signal: AbortSignal) => {
  let lastText = ''
  let numTurns = 1
  for (const step of steps) {
    if (step.kind === 'say') {
      lastText = step.text
      assistant([{ type: 'text', text: step.text }])
    } else if (step.kind === 'tool') {
      numTurns++
      await runTool(step, signal)
    } else if (step.kind === 'park') {
      writeFileSync(join(signalDir, `${step.name}.reached`), '')
      await waitForFile(join(signalDir, `${step.name}.go`), signal)
    } else if (step.kind === 'cancelQueued') {
      for (const u of state.queue.splice(0)) lifecycle(u.uuid, 'cancelled')
    } else if (step.kind === 'hang') {
      await new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Aborted()), { once: true }),
      )
    } else {
      exit(step.code)
      return undefined
    }
  }
  return { lastText, numTurns }
}

const finishAborted = (user: Queued) => {
  if (state.currentToolUseId !== undefined) {
    toolResult(
      state.currentToolUseId,
      "The user doesn't want to proceed with this tool use. The tool use was rejected.",
      true,
      { non_execution_kind: 'user-rejected' },
    )
    state.currentToolUseId = undefined
  }
  out({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
    },
    parent_tool_use_id: null,
    ...stamp(),
  })
  result(
    {
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
      stop_reason: 'tool_use',
    },
    user.uuid,
    1,
  )
  lifecycle(user.uuid, 'cancelled')
}

const runTurn = async (user: Queued) => {
  const phase = user.priority === 'next' ? script.next : script.first
  lifecycle(user.uuid, 'started')
  record({ type: 'user', uuid: user.uuid, message: { role: 'user', content: user.content } })
  out({
    type: 'system',
    subtype: 'init',
    cwd,
    ...stamp(),
    tools: [],
    mcp_servers: [],
    model: 'fake-cli',
    permissionMode: 'bypassPermissions',
    capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
    user_message_uuids: [user.uuid],
  })
  const controller = new AbortController()
  state.running = controller
  try {
    const done = await runSteps(phase.steps, controller.signal)
    if (done === undefined) return
    const { finish } = phase
    result(
      {
        subtype: finish.subtype ?? 'success',
        is_error: finish.isError,
        terminal_reason: finish.terminalReason ?? (finish.isError ? 'api_error' : 'completed'),
        stop_reason: 'end_turn',
        api_error_status: finish.isError ? 500 : null,
        result: finish.text ?? done.lastText,
      },
      user.uuid,
      done.numTurns,
    )
    lifecycle(user.uuid, 'completed')
  } catch (error) {
    if (!(error instanceof Aborted)) throw error
    finishAborted(user)
  } finally {
    state.running = undefined
  }
}

const hasTranscript = () => {
  try {
    return readdirSync(projectsDir).some((dir) =>
      existsSync(join(projectsDir, dir, `${sessionId}.jsonl`)),
    )
  } catch {
    return false
  }
}

const initialize = (requestId: string, body: z.output<typeof Incoming>['request']) => {
  const hooks = body?.hooks
  state.hookCallbackId = hooks?.PreToolUse[0]?.hookCallbackIds[0]
  const servers = body?.sdkMcpServers
  out({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: [],
        account: { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' },
        pid: process.pid,
        claude_code_version: '2.1.332',
        current_permission_mode: 'bypassPermissions',
        hook_on_failure_supported: true,
        ...(hooks === undefined ? {} : { hooks_applied: true }),
        ...(servers === undefined
          ? {}
          : { sdk_mcp_manifests_parked: Object.fromEntries(servers.map((m) => [m, 'parked'])) }),
        capabilities: [],
      },
      pending_permission_requests: [],
      pending_user_dialog_requests: [],
    },
  })
  if (resumeId !== undefined && !hasTranscript()) {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      errors: [`No conversation found with session ID: ${resumeId}`],
      ...stamp(),
    })
    exit(1)
  }
}

const interrupt = (requestId: string, cancelQueued: boolean) => {
  const cancelled = state.queue.splice(cancelQueued ? 0 : state.queue.length)
  for (const u of cancelled) lifecycle(u.uuid, 'cancelled')
  out({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        still_queued: state.queue.map((u) => u.uuid),
        ...(cancelQueued ? { cancelled: cancelled.map((u) => u.uuid) } : {}),
      },
    },
  })
  state.interrupted = true
  state.running?.abort()
}

const onLine = (line: string) => {
  if (state.exiting) return
  appendFileSync(join(signalDir, 'received.jsonl'), `${line}\n`)
  const msg = Incoming.parse(JSON.parse(line))
  if (msg.type === 'user') {
    const uuid = msg.uuid ?? crypto.randomUUID()
    state.queue.push({ uuid, priority: msg.priority, content: msg.message?.content })
    lifecycle(uuid, 'queued')
    state.wake?.()
  } else if (msg.type === 'control_response' && msg.response) {
    const settle = state.pending.get(msg.response.request_id)
    state.pending.delete(msg.response.request_id)
    settle?.(msg.response)
  } else if (msg.type === 'control_request' && msg.request && msg.request_id) {
    if (msg.request.subtype === 'initialize') initialize(msg.request_id, msg.request)
    else if (msg.request.subtype === 'interrupt')
      interrupt(msg.request_id, msg.request.cancel_queued === true)
  }
}

const main = async () => {
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') onLine(line)
  })
  process.stdin.on('end', () => {
    state.inputClosed = true
    state.wake?.()
  })
  for (;;) {
    if (state.exiting) return
    const next = state.queue.shift()
    if (next) await runTurn(next)
    else if (state.inputClosed) return exit(state.interrupted ? 1 : 0)
    else await new Promise<void>((resolve) => (state.wake = resolve))
  }
}

if (import.meta.main) await main()
