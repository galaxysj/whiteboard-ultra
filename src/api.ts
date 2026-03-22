import type {
  AIProviderSettings,
  AgentAskRequest,
  AgentAskResponse,
  AgentBuildRequest,
  AgentBuildResponse,
  AgentToolEvent,
  Asset,
  Board,
  BoardElement,
} from '../shared/types.ts'

const parseErrorText = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map((entry) => parseErrorText(entry)).filter(Boolean).join(' | ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const direct =
      (typeof record.error === 'string' && record.error) ||
      (typeof record.message === 'string' && record.message) ||
      (typeof record.detail === 'string' && record.detail)
    if (direct) return direct.trim()
    const nested =
      parseErrorText(record.error) || parseErrorText(record.details) || parseErrorText(record.message)
    if (nested) return nested
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

const extractResponseError = async (response: Response) => {
  const raw = (await response.text()).trim()
  if (!raw) return `Request failed with ${response.status} ${response.statusText}`.trim()
  try {
    const payload = JSON.parse(raw) as { error?: unknown; details?: unknown; message?: unknown }
    return (
      parseErrorText(payload.error) ||
      parseErrorText(payload.details) ||
      parseErrorText(payload.message) ||
      raw
    )
  } catch {
    return raw
  }
}

const asJson = async <T>(response: Response): Promise<T> => {
  const raw = await response.text()
  const parse = () => {
    if (!raw.trim()) return {} as T
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error(`Invalid JSON response (${response.status}).`)
    }
  }
  if (!response.ok) {
    let payload: { error?: unknown; details?: unknown; message?: unknown } | null = null
    try {
      payload = parse() as { error?: unknown; details?: unknown; message?: unknown }
    } catch {
      payload = null
    }
    throw new Error(
      (payload &&
        (parseErrorText(payload.error) ||
          parseErrorText(payload.details) ||
          parseErrorText(payload.message))) ||
        raw ||
        `Request failed with ${response.status} ${response.statusText}`.trim(),
    )
  }
  return parse()
}

export const api = {
  listBoards: async () =>
    asJson<Board[]>(await fetch('/api/boards')),
  getBoard: async (id: string) =>
    asJson<Board>(await fetch(`/api/boards/${id}`)),
  createBoard: async (name: string) =>
    asJson<Board>(
      await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
  updateBoard: async (id: string, name: string) =>
    asJson<Board>(
      await fetch(`/api/boards/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    ),
  deleteBoard: async (id: string) => {
    const response = await fetch(`/api/boards/${id}`, { method: 'DELETE' })
    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to delete board.')
    }
  },
  saveElements: async (id: string, elements: BoardElement[], updatedAt?: string) =>
    asJson<Board>(
      await fetch(`/api/boards/${id}/elements`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements, updatedAt }),
      }),
    ),
  listAssets: async (boardId: string) =>
    asJson<Asset[]>(await fetch(`/api/assets?boardId=${encodeURIComponent(boardId)}`)),
  uploadAsset: async (boardId: string, kind: Asset['kind'], file: File) => {
    const form = new FormData()
    form.append('boardId', boardId)
    form.append('kind', kind)
    form.append('file', file)
    return asJson<Asset>(
      await fetch('/api/assets', {
        method: 'POST',
        body: form,
      }),
    )
  },
  getAISettings: async () =>
    asJson<AIProviderSettings>(await fetch('/api/settings/ai')),
  saveAISettings: async (settings: AIProviderSettings) =>
    asJson<AIProviderSettings>(
      await fetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    ),
  askAgent: async (payload: AgentAskRequest) =>
    asJson<AgentAskResponse>(
      await fetch('/api/agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ),
  askAgentStream: async (
    payload: AgentAskRequest,
    handlers: {
      onThinkingStart?: () => void
      onThoughtComplete?: (thoughtSeconds: number) => void
      onTool?: (event: AgentToolEvent) => void
      onChunk: (chunk: string) => void
    },
  ) => {
    const response = await fetch('/api/agent/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(await extractResponseError(response))
    }
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Streaming response is not available.')
    }
    const decoder = new TextDecoder()
    let full = ''
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const event = JSON.parse(trimmed) as
          | { type: 'thinking_start' }
          | { type: 'thought_complete'; thoughtSeconds?: number }
          | { type: 'tool'; event: AgentToolEvent }
          | { type: 'token'; value: string }
          | { type: 'done' }
        if (event.type === 'thinking_start') handlers.onThinkingStart?.()
        if (event.type === 'thought_complete') handlers.onThoughtComplete?.(event.thoughtSeconds ?? 0)
        if (event.type === 'tool') handlers.onTool?.(event.event)
        if (event.type === 'token') {
          full += event.value
          handlers.onChunk(event.value)
        }
      }
    }
    return { answer: full, toolEvents: [] } satisfies AgentAskResponse
  },
  buildWithAgent: async (payload: AgentBuildRequest) =>
    asJson<AgentBuildResponse>(
      await fetch('/api/agent/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ),
}
