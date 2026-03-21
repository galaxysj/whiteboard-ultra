import { nanoid } from 'nanoid'
import type {
  AIProviderSettings,
  AgentBuildResponse,
  Board,
  BoardElement,
  BuildOperation,
  Point,
} from '../shared/types.js'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../shared/types.js'

const ensureConfigured = (settings: AIProviderSettings) => {
  if (!settings.apiKey.trim()) {
    throw new Error('AI API key is not configured.')
  }
  if (settings.providerType === 'compatible' && !settings.baseUrl.trim()) {
    throw new Error('OpenAI compatible base URL is required.')
  }
}

const stripCodeFence = (input: string) =>
  input
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')

const extractFirstJsonObject = (input: string) => {
  const start = input.indexOf('{')
  const end = input.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return null
  }
  return input.slice(start, end + 1)
}

const extractText = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload
  }
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => extractText(entry))
      .filter(Boolean)
      .join('\n')
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.text === 'string') {
      return record.text
    }
    if (typeof record.output_text === 'string') {
      return record.output_text
    }
    if (record.message) {
      return extractText(record.message)
    }
    if (record.parts) {
      return extractText(record.parts)
    }
    if (record.content) {
      return extractText(record.content)
    }
    if (record.candidates) {
      return extractText(record.candidates)
    }
    if (record.choices) {
      return extractText(record.choices)
    }
  }
  return ''
}

const callOpenAI = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelId,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: system }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as Record<string, unknown>
  const fromField = typeof payload.output_text === 'string' ? payload.output_text : ''
  const fromOutput = extractText(payload.output)
  return fromField || fromOutput
}

const callCompatible = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
) => {
  const baseUrl = settings.baseUrl.replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelId,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Compatible API request failed: ${response.status} ${response.statusText}`,
    )
  }

  const payload = (await response.json()) as Record<string, unknown>
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  return extractText(choices[0])
}

const callGemini = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
) => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelId}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `Gemini request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
    )
  }

  const payload = (await response.json()) as Record<string, unknown>
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  return extractText(candidates[0])
}

export const generateAgentResponse = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
) => {
  ensureConfigured(settings)

  let responseText = ''
  switch (settings.providerType) {
    case 'gemini':
      responseText = await callGemini(settings, system, prompt)
      break
    case 'openai':
      responseText = await callOpenAI(settings, system, prompt)
      break
    case 'compatible':
      responseText = await callCompatible(settings, system, prompt)
      break
    default:
      throw new Error('Unsupported provider.')
  }

  const normalized = responseText.trim()
  if (!normalized) {
    throw new Error('AI provider returned an empty response.')
  }
  return normalized
}

const summarizeElement = (element: BoardElement, viewOrigin?: Point) => ({
  id: element.id,
  type: element.type,
  position: {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    xInView: viewOrigin ? element.x - viewOrigin.x : element.x,
    yInView: viewOrigin ? element.y - viewOrigin.y : element.y,
  },
  details:
    element.type === 'latex'
      ? { latex: element.latex }
      : element.type === 'iframe'
        ? { src: element.src, title: element.title }
        : element.type === 'image' || element.type === 'video' || element.type === 'file'
          ? { name: element.name, src: element.src }
          : element.type === 'graph'
            ? {
                xMin: element.xMin,
                xMax: element.xMax,
                yMin: element.yMin,
                yMax: element.yMax,
              }
            : element.type === 'compass'
              ? {
                  radius: element.radius,
                  startAngle: element.startAngle,
                  endAngle: element.endAngle,
                }
              : undefined,
})

export const boardContext = (board: Board, selectedElementId?: string, viewOrigin?: Point) => ({
  board: {
    id: board.id,
    name: board.name,
    elementCount: board.elements.length,
    selectedElementId: selectedElementId ?? null,
    viewOrigin: viewOrigin ?? null,
    elements: board.elements.map((element) => summarizeElement(element, viewOrigin)),
  },
})

const now = () => new Date().toISOString()

const asNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))
const normalizeCreateType = (value: string): BoardElement['type'] => {
  const raw = value.trim().toLowerCase()
  if (raw === '자' || raw === 'ruler' || raw === 'straightedge') return 'ruler'
  if (raw === '각도기' || raw === 'protractor') return 'protractor'
  if (raw === '원' || raw === 'circle') return 'ellipse'
  if (raw === '사각형' || raw === 'rect' || raw === 'box') return 'rectangle'
  if (raw === '화살표') return 'arrow'
  if (raw === '직선') return 'line'
  if (raw === '이미지') return 'image'
  if (raw === '동영상' || raw === '비디오') return 'video'
  if (raw === '파일') return 'file'
  if (raw === '수식') return 'latex'
  if (raw === '좌표그래프') return 'graph'
  if (
    raw === 'pen' ||
    raw === 'line' ||
    raw === 'arrow' ||
    raw === 'rectangle' ||
    raw === 'ellipse' ||
    raw === 'iframe' ||
    raw === 'image' ||
    raw === 'video' ||
    raw === 'file' ||
    raw === 'compass' ||
    raw === 'graph' ||
    raw === 'latex' ||
    raw === 'ruler' ||
    raw === 'protractor'
  ) {
    return raw
  }
  return 'rectangle'
}

const sanitizeOperationElement = (
  element: Partial<BoardElement> & { type: string },
  zIndex: number,
) => {
  const timestamp = now()
  const id = typeof element.id === 'string' ? element.id : nanoid()
  const type = element.type as BoardElement['type']
  const x = asNumber(element.x, 1200)
  const y = asNumber(element.y, 1200)
  const rotation = asNumber(element.rotation, 0)
  const stroke = typeof element.stroke === 'string' ? element.stroke : '#183153'
  const strokeWidth = asNumber(element.strokeWidth, 2)
  const raw = element as Record<string, unknown>
  const base = {
    id,
    type,
    x,
    y,
    rotation,
    stroke,
    strokeWidth,
    zIndex,
    createdAt: typeof element.createdAt === 'string' ? element.createdAt : timestamp,
    updatedAt: timestamp,
  }

  switch (type) {
    case 'pen': {
      const rawPoints = Array.isArray(raw.points) ? raw.points : []
      const points =
        rawPoints.length >= 2
          ? rawPoints
          : [{ x: 0, y: 0 }, { x: 80, y: 40 }]
      const localPoints = points.map((point: unknown) => ({
        x: asNumber((point as { x?: unknown }).x, 0),
        y: asNumber((point as { y?: unknown }).y, 0),
      }))
      const maxX = Math.max(8, ...localPoints.map((point) => point.x))
      const maxY = Math.max(8, ...localPoints.map((point) => point.y))
      return {
        ...base,
        type: 'pen',
        width: Math.max(8, asNumber(element.width, maxX)),
        height: Math.max(8, asNumber(element.height, maxY)),
        fill: 'transparent',
        points: localPoints,
      } as BoardElement
    }
    case 'line':
    case 'arrow': {
      const width = Math.max(2, asNumber(element.width, 180))
      const height = Math.max(2, asNumber(element.height, 120))
      const rawLinePoints = Array.isArray(raw.linePoints) ? raw.linePoints : []
      const linePoints =
        rawLinePoints.length >= 2
          ? [
              {
                x: asNumber((rawLinePoints[0] as { x?: unknown }).x, 0),
                y: asNumber((rawLinePoints[0] as { y?: unknown }).y, height),
              },
              {
                x: asNumber((rawLinePoints[1] as { x?: unknown }).x, width),
                y: asNumber((rawLinePoints[1] as { y?: unknown }).y, 0),
              },
            ]
          : [{ x: 0, y: height }, { x: width, y: 0 }]
      return {
        ...base,
        type,
        width,
        height,
        fill: 'transparent',
        linePoints,
      } as BoardElement
    }
    case 'rectangle':
    case 'ellipse':
      return {
        ...base,
        type,
        width: Math.max(24, asNumber(element.width, 180)),
        height: Math.max(24, asNumber(element.height, 120)),
        fill: 'transparent',
      } as BoardElement
    case 'iframe':
      return {
        ...base,
        type: 'iframe',
        width: Math.max(24, asNumber(element.width, 480)),
        height: Math.max(24, asNumber(element.height, 280)),
        fill:
          typeof element.fill === 'string' ? element.fill : 'rgba(255,255,255,0.55)',
        src:
          typeof (element as { src?: unknown }).src === 'string'
            ? (element as { src: string }).src
            : 'https://example.com',
        title:
          typeof (element as { title?: unknown }).title === 'string'
            ? (element as { title: string }).title
            : 'Embedded content',
      } as BoardElement
    case 'image':
    case 'video':
    case 'file':
      return {
        ...base,
        type,
        width: Math.max(24, asNumber(element.width, type === 'file' ? 280 : 320)),
        height: Math.max(24, asNumber(element.height, type === 'file' ? 96 : 220)),
        fill:
          typeof element.fill === 'string'
            ? element.fill
            : type === 'file'
              ? 'rgba(246, 231, 201, 0.95)'
              : 'rgba(255,255,255,0.92)',
        assetId:
          typeof (element as { assetId?: unknown }).assetId === 'string'
            ? (element as { assetId: string }).assetId
            : nanoid(),
        name:
          typeof (element as { name?: unknown }).name === 'string'
            ? (element as { name: string }).name
            : `${type} asset`,
        src:
          typeof (element as { src?: unknown }).src === 'string'
            ? (element as { src: string }).src
            : '',
        mimeType:
          typeof (element as { mimeType?: unknown }).mimeType === 'string'
            ? (element as { mimeType: string }).mimeType
            : 'application/octet-stream',
      } as BoardElement
    case 'compass': {
      const radius = Math.max(24, asNumber((element as { radius?: unknown }).radius, 100))
      return {
        ...base,
        type: 'compass',
        width: radius * 2,
        height: radius * 2,
        fill: 'transparent',
        radius,
        startAngle: asNumber((element as { startAngle?: unknown }).startAngle, 18),
        endAngle: asNumber((element as { endAngle?: unknown }).endAngle, 312),
      } as BoardElement
    }
    case 'graph':
      return {
        ...base,
        type: 'graph',
        width: Math.max(24, asNumber(element.width, 360)),
        height: Math.max(24, asNumber(element.height, 240)),
        fill:
          typeof element.fill === 'string' ? element.fill : 'rgba(255,255,255,0.55)',
        unit: asNumber((element as { unit?: unknown }).unit, 20),
        xMin: asNumber((element as { xMin?: unknown }).xMin, -8),
        xMax: asNumber((element as { xMax?: unknown }).xMax, 8),
        yMin: asNumber((element as { yMin?: unknown }).yMin, -5),
        yMax: asNumber((element as { yMax?: unknown }).yMax, 5),
      } as BoardElement
    case 'latex':
      return {
        ...base,
        type: 'latex',
        width: Math.max(24, asNumber(element.width, 300)),
        height: Math.max(24, asNumber(element.height, 110)),
        fill:
          typeof element.fill === 'string' ? element.fill : 'rgba(255,255,255,0.92)',
        latex:
          typeof (element as { latex?: unknown }).latex === 'string'
            ? (element as { latex: string }).latex
            : 'f(x)=x^2+3x+2',
        fontSize: asNumber((element as { fontSize?: unknown }).fontSize, 28),
      } as BoardElement
    case 'ruler':
      return {
        ...base,
        type: 'ruler',
        width: Math.max(24, asNumber(element.width, 720)),
        height: Math.max(24, asNumber(element.height, 96)),
        fill:
          typeof element.fill === 'string' ? element.fill : 'rgba(242, 204, 97, 0.35)',
        units: asNumber((element as { units?: unknown }).units, 18),
      } as BoardElement
    case 'protractor':
      return {
        ...base,
        type: 'protractor',
        width: Math.max(24, asNumber(element.width, 280)),
        height: Math.max(24, asNumber(element.height, 150)),
        fill:
          typeof element.fill === 'string' ? element.fill : 'rgba(82, 174, 215, 0.18)',
      } as BoardElement
    default:
      return {
        ...base,
        type: 'rectangle',
        width: Math.max(24, asNumber(element.width, 180)),
        height: Math.max(24, asNumber(element.height, 120)),
        fill: 'transparent',
      } as BoardElement
  }
}

export const applyBuildOperations = (
  elements: BoardElement[],
  operations: BuildOperation[],
) => {
  let next = [...elements]

  const nextZIndex = (items: BoardElement[]) =>
    items.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1

  for (const operation of operations) {
    if (operation.type === 'create') {
      next.push(sanitizeOperationElement(operation.element, nextZIndex(next)))
    }
    if (operation.type === 'update') {
      next = next.map((element) =>
        element.id === operation.id
          ? ({
              ...element,
              ...operation.patch,
              id: element.id,
              updatedAt: now(),
            } as BoardElement)
          : element,
      )
    }
    if (operation.type === 'delete') {
      next = next.filter((element) => element.id !== operation.id)
    }
  }

  return next.map((element, index) => ({ ...element, zIndex: index + 1 }))
}

type BuildToolName =
  | 'get_board_state'
  | 'create_element'
  | 'update_element'
  | 'delete_element'

type BuildRuntime = {
  board: Board
  selectedElementId?: string
  viewOrigin: Point
  elements: BoardElement[]
  operations: BuildOperation[]
}

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return {}
    } catch {
      return {}
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

const readToolName = (value: unknown): BuildToolName | null => {
  if (
    value === 'get_board_state' ||
    value === 'create_element' ||
    value === 'update_element' ||
    value === 'delete_element'
  ) {
    return value
  }
  return null
}

const executeBuildTool = (
  runtime: BuildRuntime,
  toolName: BuildToolName,
  args: Record<string, unknown>,
) => {
  if (toolName === 'get_board_state') {
    return boardContext(
      {
        ...runtime.board,
        elements: runtime.elements,
      },
      runtime.selectedElementId,
      runtime.viewOrigin,
    )
  }

  if (toolName === 'create_element') {
    const type = normalizeCreateType(typeof args.type === 'string' ? args.type : 'rectangle')
    const anchor = args.anchor === 'top-left' ? 'top-left' : 'center'
    const requestedX = asNumber(args.x, 0)
    const requestedY = asNumber(args.y, 0)
    const x = runtime.viewOrigin.x + requestedX
    const y = runtime.viewOrigin.y + requestedY
    const propsRaw = parseJsonObject(args.props)
    const seed = {
      ...(propsRaw as Partial<BoardElement>),
      type,
      x: 0,
      y: 0,
    } as Partial<BoardElement> & { type: string }
    const draft = sanitizeOperationElement(
      seed,
      runtime.elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1,
    )
    const placedX = anchor === 'center' ? x - draft.width / 2 : x
    const placedY = anchor === 'center' ? y - draft.height / 2 : y
    const element = {
      ...draft,
      x: clamp(placedX, 0, CANVAS_WIDTH - Math.max(1, draft.width)),
      y: clamp(placedY, 0, CANVAS_HEIGHT - Math.max(1, draft.height)),
    } as BoardElement
    const operation: BuildOperation = {
      type: 'create',
      element: element as Partial<BoardElement> & { type: BoardElement['type'] },
    }
    runtime.elements = applyBuildOperations(runtime.elements, [operation])
    runtime.operations.push(operation)
    const created = runtime.elements[runtime.elements.length - 1]
    return {
      ok: true,
      id: created?.id ?? null,
      element: created ? summarizeElement(created) : null,
    }
  }

  if (toolName === 'update_element') {
    const id = typeof args.id === 'string' ? args.id : ''
    const patch = parseJsonObject(args.patch) as Partial<BoardElement>
    const nextPatch = { ...patch }
    if (typeof patch.x === 'number') {
      nextPatch.x = runtime.viewOrigin.x + patch.x
    }
    if (typeof patch.y === 'number') {
      nextPatch.y = runtime.viewOrigin.y + patch.y
    }
    if (!id) {
      return { ok: false, error: 'id is required.' }
    }
    const exists = runtime.elements.some((element) => element.id === id)
    if (!exists) {
      return { ok: false, error: `Element not found: ${id}` }
    }
    const operation: BuildOperation = { type: 'update', id, patch: nextPatch }
    runtime.elements = applyBuildOperations(runtime.elements, [operation])
    runtime.operations.push(operation)
    return { ok: true, id }
  }

  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) {
    return { ok: false, error: 'id is required.' }
  }
  const exists = runtime.elements.some((element) => element.id === id)
  if (!exists) {
    return { ok: false, error: `Element not found: ${id}` }
  }
  const operation: BuildOperation = { type: 'delete', id }
  runtime.elements = applyBuildOperations(runtime.elements, [operation])
  runtime.operations.push(operation)
  return { ok: true, id }
}

const buildToolsForResponses = [
  {
    type: 'function',
    name: 'get_board_state',
    description: 'Read the latest whiteboard state.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_element',
    description:
      'Create one real board element. Use exact element type (for example ruler/protractor, not symbolic shapes). x,y are center coordinates by default.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        anchor: { type: 'string' },
        props: { type: 'object' },
      },
      required: ['type', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_element',
    description: 'Update element fields by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object' },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_element',
    description: 'Delete an element by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

const buildToolsForCompletions = buildToolsForResponses.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}))

const toGeminiSchema = (schema: unknown): unknown => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const record = schema as Record<string, unknown>
  const mapped: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(record)) {
    if (key === 'type' && typeof value === 'string') {
      mapped[key] = value.toUpperCase()
      continue
    }
    if (key === 'additionalProperties') {
      continue
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = value as Record<string, unknown>
      const nextProps: Record<string, unknown> = {}
      for (const [propKey, propSchema] of Object.entries(props)) {
        nextProps[propKey] = toGeminiSchema(propSchema)
      }
      mapped[key] = nextProps
      continue
    }
    if (Array.isArray(value)) {
      mapped[key] = value.map((item) => toGeminiSchema(item))
      continue
    }
    if (value && typeof value === 'object') {
      mapped[key] = toGeminiSchema(value)
      continue
    }
    mapped[key] = value
  }

  return mapped
}

const buildToolsForGemini = [
  {
    functionDeclarations: buildToolsForResponses.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.parameters),
    })),
  },
]

const buildSystemPrompt = [
  'You are Whiteboard Pro Build mode agent.',
  'Use tool calls to modify the board.',
  'Always place new elements using explicit x and y coordinates.',
  'Coordinates are relative to current view origin: the top-left of user viewport is (0,0).',
  'Coordinates are center-based unless anchor is explicitly top-left.',
  'Never use rectangle/ellipse as symbolic substitutes when a dedicated type exists (for example ruler, protractor).',
  'Keep element defaults consistent with the editor tools unless user asks otherwise.',
  'Do not output custom JSON operation lists.',
  'When done, provide a brief final text summary.',
].join(' ')

const buildUserPrompt = (
  board: Board,
  selectedElementId: string | undefined,
  prompt: string,
  viewOrigin: Point,
) =>
  [
    `Board context: ${JSON.stringify(boardContext(board, selectedElementId, viewOrigin), null, 2)}`,
    `User request: ${prompt}`,
  ].join('\n\n')

const runOpenAIToolCalls = async (settings: AIProviderSettings, runtime: BuildRuntime, prompt: string) => {
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as Record<string, unknown>
  }

  let payload = await request({
    model: settings.modelId,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: buildSystemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: prompt }] },
    ],
    tools: buildToolsForResponses,
    tool_choice: 'auto',
  })

  for (let turn = 0; turn < 12; turn += 1) {
    const responseId = typeof payload.id === 'string' ? payload.id : ''
    const output = Array.isArray(payload.output) ? payload.output : []
    const calls = output.filter((item) => {
      const record = item as Record<string, unknown>
      return record?.type === 'function_call'
    }) as Array<Record<string, unknown>>

    if (calls.length === 0) {
      const text = typeof payload.output_text === 'string' ? payload.output_text.trim() : extractText(output).trim()
      return text || `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
    }

    const outputs = calls.map((call) => {
      const name = readToolName(call.name)
      const args = parseJsonObject(call.arguments)
      const result = name
        ? executeBuildTool(runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      return {
        type: 'function_call_output',
        call_id: typeof call.call_id === 'string' ? call.call_id : nanoid(),
        output: JSON.stringify(result),
      }
    })

    payload = await request({
      model: settings.modelId,
      previous_response_id: responseId || undefined,
      input: outputs,
      tools: buildToolsForResponses,
      tool_choice: 'auto',
    })
  }

  return `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
}

const runCompatibleToolCalls = async (settings: AIProviderSettings, runtime: BuildRuntime, prompt: string) => {
  const baseUrl = settings.baseUrl.replace(/\/$/, '')
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: buildSystemPrompt },
    { role: 'user', content: prompt },
  ]

  for (let turn = 0; turn < 12; turn += 1) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.modelId,
        temperature: 0.2,
        messages,
        tools: buildToolsForCompletions,
        tool_choice: 'auto',
      }),
    })
    if (!response.ok) {
      throw new Error(
        `Compatible API request failed: ${response.status} ${response.statusText}`,
      )
    }
    const payload = (await response.json()) as Record<string, unknown>
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const message =
      choices[0] && typeof choices[0] === 'object'
        ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined)
        : undefined
    if (!message) {
      break
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (toolCalls.length === 0) {
      const text = extractText(message.content).trim()
      return text || `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls,
    })

    for (const toolCall of toolCalls) {
      const record = toolCall as Record<string, unknown>
      const fn =
        record.function && typeof record.function === 'object'
          ? (record.function as Record<string, unknown>)
          : {}
      const name = readToolName(fn.name)
      const args = parseJsonObject(fn.arguments)
      const result = name
        ? executeBuildTool(runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      messages.push({
        role: 'tool',
        tool_call_id: typeof record.id === 'string' ? record.id : nanoid(),
        content: JSON.stringify(result),
      })
    }
  }

  return `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
}

const runGeminiToolCalls = async (settings: AIProviderSettings, runtime: BuildRuntime, prompt: string) => {
  const contents: Array<Record<string, unknown>> = [
    { role: 'user', parts: [{ text: prompt }] },
  ]

  for (let turn = 0; turn < 24; turn += 1) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelId}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt }] },
          tools: buildToolsForGemini,
          contents,
        }),
      },
    )
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `Gemini request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
      )
    }
    const payload = (await response.json()) as Record<string, unknown>
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
    const candidate = candidates[0] as Record<string, unknown> | undefined
    const content =
      candidate?.content && typeof candidate.content === 'object'
        ? (candidate.content as Record<string, unknown>)
        : undefined
    const parts = Array.isArray(content?.parts) ? content?.parts : []
    const functionParts = parts.filter((part) => {
      const record = part as Record<string, unknown>
      return record.functionCall && typeof record.functionCall === 'object'
    }) as Array<Record<string, unknown>>

    if (functionParts.length === 0) {
      const text = extractText(parts).trim() || extractText(candidate).trim()
      return text || `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
    }

    contents.push({
      role: 'model',
      parts,
    })

    const responseParts: Array<Record<string, unknown>> = []
    for (const part of functionParts) {
      const fc = part.functionCall as Record<string, unknown>
      const name = readToolName(fc.name)
      const args = parseJsonObject(fc.args)
      const result = name
        ? executeBuildTool(runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      responseParts.push({
        functionResponse: {
          name: typeof fc.name === 'string' ? fc.name : 'unknown_tool',
          response: result,
        },
      })
    }
    contents.push({
      role: 'user',
      parts: responseParts,
    })
  }

  return `Applied ${runtime.operations.length} change${runtime.operations.length === 1 ? '' : 's'}.`
}

export const runBuildWithToolCalls = async (
  settings: AIProviderSettings,
  board: Board,
  prompt: string,
  selectedElementId?: string,
  viewOrigin?: Point,
): Promise<AgentBuildResponse> => {
  ensureConfigured(settings)
  const runtime: BuildRuntime = {
    board,
    selectedElementId,
    viewOrigin: viewOrigin ?? { x: 0, y: 0 },
    elements: [...board.elements],
    operations: [],
  }
  const userPrompt = buildUserPrompt(board, selectedElementId, prompt, runtime.viewOrigin)

  let message = ''
  if (settings.providerType === 'openai') {
    message = await runOpenAIToolCalls(settings, runtime, userPrompt)
  } else if (settings.providerType === 'compatible') {
    message = await runCompatibleToolCalls(settings, runtime, userPrompt)
  } else if (settings.providerType === 'gemini') {
    message = await runGeminiToolCalls(settings, runtime, userPrompt)
  } else {
    throw new Error('Unsupported provider.')
  }

  return {
    message,
    operations: runtime.operations,
    elements: runtime.elements,
  }
}

export const parseBuildResponse = (text: string, currentElements: BoardElement[]): AgentBuildResponse => {
  const cleaned = stripCodeFence(text ?? '')
  const candidate = cleaned.startsWith('{') ? cleaned : extractFirstJsonObject(cleaned)
  if (!candidate) {
    return {
      message: 'AI returned an empty or non-JSON response. No changes were applied.',
      operations: [],
      elements: currentElements,
    }
  }

  try {
    const json = JSON.parse(candidate) as Partial<AgentBuildResponse>
    const operations = Array.isArray(json.operations)
      ? (json.operations as BuildOperation[])
      : []

    return {
      message:
        typeof json.message === 'string'
          ? json.message
          : `Applied ${operations.length} change${operations.length === 1 ? '' : 's'}.`,
      operations,
      elements: applyBuildOperations(currentElements, operations),
    }
  } catch {
    return {
      message: 'AI response JSON could not be parsed. No changes were applied.',
      operations: [],
      elements: currentElements,
    }
  }
}
