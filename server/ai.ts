import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import type {
  AIProviderSettings,
  AgentConversationMessage,
  AgentAskResponse,
  AgentBuildResponse,
  AgentToolAction,
  AgentToolEvent,
  Board,
  BoardElement,
  BuildOperation,
  Point,
  Rect,
} from '../shared/types.js'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../shared/types.js'

class AIRequestError extends Error {
  status: number
  details?: string

  constructor(message: string, status = 500, details?: string) {
    super(message)
    this.name = 'AIRequestError'
    this.status = status
    this.details = details
  }
}

const summarizeErrorPayload = (payload: unknown): string => {
  if (!payload) return ''
  if (typeof payload === 'string') return payload.trim()
  if (Array.isArray(payload)) {
    return payload.map((entry) => summarizeErrorPayload(entry)).filter(Boolean).join(' | ')
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const direct =
      (typeof record.error === 'string' && record.error) ||
      (typeof record.message === 'string' && record.message) ||
      (typeof record.detail === 'string' && record.detail)
    if (direct) return direct.trim()
    const nested =
      summarizeErrorPayload(record.error) ||
      summarizeErrorPayload(record.details) ||
      summarizeErrorPayload(record.message)
    if (nested) return nested
    try {
      return JSON.stringify(payload)
    } catch {
      return ''
    }
  }
  return String(payload)
}

const readErrorDetails = async (response: Response) => {
  const raw = (await response.text().catch(() => '')).trim()
  if (!raw) return ''
  try {
    return summarizeErrorPayload(JSON.parse(raw)) || raw
  } catch {
    return raw
  }
}

const throwRequestError = async (provider: string, response: Response) => {
  const details = await readErrorDetails(response)
  const message = `${provider} request failed: ${response.status} ${response.statusText}${
    details ? ` - ${details}` : ''
  }`
  throw new AIRequestError(message, response.status >= 500 ? 502 : response.status, details)
}

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
    await throwRequestError('OpenAI', response)
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
    await throwRequestError('Compatible API', response)
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
    await throwRequestError('Gemini', response)
  }

  const payload = (await response.json()) as Record<string, unknown>
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  return extractText(candidates[0])
}

type StreamDeltaHandler = (delta: string) => void

const readSse = async (response: Response, onEvent: (payload: string) => void) => {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('AI provider did not return a readable stream.')
  }
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) break
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLines = rawEvent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
      if (dataLines.length === 0) continue
      const payload = dataLines.map((line) => line.slice(5).trim()).join('\n')
      if (payload) onEvent(payload)
    }
  }
}

const callOpenAIStream = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
  onDelta: StreamDeltaHandler,
) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelId,
      stream: true,
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
    await throwRequestError('OpenAI', response)
  }
  await readSse(response, (payload) => {
    if (payload === '[DONE]') return
    try {
      const event = JSON.parse(payload) as { type?: string; delta?: string }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        onDelta(event.delta)
      }
    } catch {
      // Ignore malformed stream fragments and continue.
    }
  })
}

const callCompatibleStream = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
  onDelta: StreamDeltaHandler,
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
      stream: true,
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
  await readSse(response, (payload) => {
    if (payload === '[DONE]') return
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>
      }
      const delta = event.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) onDelta(delta)
    } catch {
      // Ignore malformed stream fragments and continue.
    }
  })
}

const callGeminiStream = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
  onDelta: StreamDeltaHandler,
) => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelId}:streamGenerateContent?alt=sse&key=${encodeURIComponent(settings.apiKey)}`,
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
  await readSse(response, (payload) => {
    if (payload === '[DONE]') return
    try {
      const event = JSON.parse(payload) as Record<string, unknown>
      const text = extractText(event)
      if (text) onDelta(text)
    } catch {
      // Ignore malformed stream fragments and continue.
    }
  })
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

export const streamAgentResponse = async (
  settings: AIProviderSettings,
  system: string,
  prompt: string,
  onDelta: StreamDeltaHandler,
) => {
  ensureConfigured(settings)

  switch (settings.providerType) {
    case 'gemini':
      await callGeminiStream(settings, system, prompt, onDelta)
      return
    case 'openai':
      await callOpenAIStream(settings, system, prompt, onDelta)
      return
    case 'compatible':
      await callCompatibleStream(settings, system, prompt, onDelta)
      return
    default:
      throw new Error('Unsupported provider.')
  }
}

const summarizeElement = (element: BoardElement) => ({
  id: element.id,
  type: element.type,
  position: {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
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
                expressions: element.expressions,
              }
            : element.type === 'compass'
              ? {
                  radius: element.radius,
                  startAngle: element.startAngle,
                  endAngle: element.endAngle,
                }
              : undefined,
})

export const boardContext = (board: Board, selectedElementId?: string, viewOrigin?: Point, viewBounds?: Rect) => ({
  board: {
    id: board.id,
    name: board.name,
    elementCount: board.elements.length,
    selectedElementId: selectedElementId ?? null,
    viewOrigin: viewOrigin ?? null,
    visibleRange: viewBounds
      ? {
          startx: viewBounds.x,
          starty: viewBounds.y,
          endx: viewBounds.x + viewBounds.width,
          endy: viewBounds.y + viewBounds.height,
          width: viewBounds.width,
          height: viewBounds.height,
        }
      : null,
    elements: board.elements.map((element) => summarizeElement(element)),
  },
})

const createToolEvent = (label: string, detail?: string, action?: AgentToolAction): AgentToolEvent => ({
  id: nanoid(),
  label,
  detail,
  action,
  createdAt: now(),
})

const detailedBoardSnapshot = (elements: BoardElement[]) =>
  elements.map((element) => ({
    id: element.id,
    type: element.type,
    startx: element.x,
    starty: element.y,
    endx: element.x + element.width,
    endy: element.y + element.height,
    width: element.width,
    height: element.height,
    thickness: element.strokeWidth,
    color: element.stroke,
    fill: element.fill,
    rotation: element.rotation,
    targetlink:
      element.type === 'iframe'
        ? element.src
        : element.type === 'image' || element.type === 'video' || element.type === 'file'
          ? element.src
          : undefined,
    text:
      element.type === 'text' || element.type === 'markdown'
        ? element.text
        : element.type === 'latex'
          ? element.latex
          : undefined,
    code:
      element.type === 'code' || element.type === 'monaco'
        ? element.code
        : undefined,
    language:
      element.type === 'code' || element.type === 'monaco'
        ? element.language
        : undefined,
    expressions: element.type === 'graph' ? element.expressions : undefined,
    xmin: element.type === 'graph' ? element.xMin : undefined,
    xmax: element.type === 'graph' ? element.xMax : undefined,
    ymin: element.type === 'graph' ? element.yMin : undefined,
    ymax: element.type === 'graph' ? element.yMax : undefined,
    units: element.type === 'ruler' ? element.units : undefined,
    radius: element.type === 'compass' ? element.radius : undefined,
    startAngle: element.type === 'compass' ? element.startAngle : undefined,
    endAngle: element.type === 'compass' ? element.endAngle : undefined,
  }))

const elementSearchText = (element: BoardElement) =>
  JSON.stringify(detailedBoardSnapshot([element])[0]).toLowerCase()

const now = () => new Date().toISOString()

const asNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))
const readStringArg = (args: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return ''
}
const estimateTextLines = (text: string) => Math.max(1, text.split('\n').length)
const estimateTextColumns = (text: string) =>
  Math.max(1, ...text.split('\n').map((line) => line.trimEnd().length))
const estimateTextBoxSize = (text: string, fontSize: number, kind: 'text' | 'markdown') => ({
  width: Math.max(kind === 'text' ? 28 : 120, Math.round(fontSize * (estimateTextColumns(text || 'Text') * 0.58 + 1.2))),
  height: Math.max(kind === 'text' ? 24 : 52, Math.round(fontSize * (estimateTextLines(text || 'Text') * 1.35 + 0.7))),
})
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
      const rawExpressions = Array.isArray((element as { expressions?: unknown }).expressions)
        ? ((element as { expressions?: unknown[] }).expressions ?? [])
        : []
      const expressions = rawExpressions
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
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
        expressions: expressions.length > 0 ? expressions : ['x'],
      } as BoardElement
    case 'text':
    case 'markdown':
      const fallbackFontSize = type === 'text' ? 28 : 18
      const textValue =
        typeof (element as { text?: unknown }).text === 'string'
          ? (element as { text: string }).text
          : ''
      const fontSize = clamp(asNumber((element as { fontSize?: unknown }).fontSize, fallbackFontSize), 1, 50)
      const textBox = estimateTextBoxSize(textValue, fontSize, type)
      return {
        ...base,
        type,
        width: Math.max(type === 'text' ? 28 : 120, asNumber(element.width, textBox.width)),
        height: Math.max(type === 'text' ? 24 : 52, asNumber(element.height, textBox.height)),
        fill: typeof element.fill === 'string' ? element.fill : 'transparent',
        stroke: typeof element.stroke === 'string' ? element.stroke : 'transparent',
        text: textValue,
        fontSize,
      } as BoardElement
    case 'code':
    case 'monaco':
      return {
        ...base,
        type,
        width: Math.max(24, asNumber(element.width, type === 'code' ? 420 : 520)),
        height: Math.max(24, asNumber(element.height, type === 'code' ? 180 : 320)),
        fill: typeof element.fill === 'string' ? element.fill : '#eef1f4',
        stroke: typeof element.stroke === 'string' ? element.stroke : 'transparent',
        code:
          typeof (element as { code?: unknown }).code === 'string'
            ? (element as { code: string }).code
            : '',
        language:
          typeof (element as { language?: unknown }).language === 'string'
            ? (element as { language: string }).language
            : 'javascript',
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
  | 'capture_board'
  | 'get_board'
  | 'move_mouse'
  | 'move_user_viewport'
  | 'wait'
  | 'draw_dot'
  | 'draw_line'
  | 'draw_arrow'
  | 'draw_square'
  | 'draw_circle'
  | 'embed_link'
  | 'write_text'
  | 'write_md'
  | 'write_latex'
  | 'write_code'
  | 'write_monaco'
  | 'make_graph'
  | 'add_ruler'
  | 'add_protractor'
  | 'move_element'
  | 'delete_element'

type AskToolName =
  | 'capture_board'
  | 'get_board'
  | 'move_mouse'
  | 'move_user_viewport'
  | 'wait'
  | 'search_element'

type RuntimeBase = {
  board: Board
  selectedElementId?: string
  viewOrigin: Point
  elements: BoardElement[]
  screenshotDataUrl?: string
  toolEvents: AgentToolEvent[]
}

type BuildRuntime = RuntimeBase & {
  operations: BuildOperation[]
}

type AskRuntime = RuntimeBase

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

const readBuildToolName = (value: unknown): BuildToolName | null => {
  if (value === 'Wait') return 'wait'
  if (
    value === 'capture_board' ||
    value === 'get_board' ||
    value === 'move_mouse' ||
    value === 'move_user_viewport' ||
    value === 'wait' ||
    value === 'draw_dot' ||
    value === 'draw_line' ||
    value === 'draw_arrow' ||
    value === 'draw_square' ||
    value === 'draw_circle' ||
    value === 'embed_link' ||
    value === 'write_text' ||
    value === 'write_md' ||
    value === 'write_latex' ||
    value === 'write_code' ||
    value === 'write_monaco' ||
    value === 'make_graph' ||
    value === 'add_ruler' ||
    value === 'add_protractor' ||
    value === 'move_element' ||
    value === 'delete_element'
  ) {
    return value
  }
  return null
}

const readAskToolName = (value: unknown): AskToolName | null => {
  if (value === 'Wait') return 'wait'
  if (
    value === 'capture_board' ||
    value === 'get_board' ||
    value === 'move_mouse' ||
    value === 'move_user_viewport' ||
    value === 'wait' ||
    value === 'search_element'
  ) {
    return value
  }
  return null
}

const pushRuntimeToolEvent = (runtime: RuntimeBase, label: string, detail?: string, action?: AgentToolAction) => {
  runtime.toolEvents.push(createToolEvent(label, detail, action))
}

const supportsVision = (settings: AIProviderSettings) => settings.providerType !== 'compatible'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const createBuildElementOperation = (
  runtime: BuildRuntime,
  element: Partial<BoardElement> & { type: BoardElement['type'] },
) => {
  const operation: BuildOperation = {
    type: 'create',
    element,
  }
  runtime.elements = applyBuildOperations(runtime.elements, [operation])
  runtime.operations.push(operation)
  return runtime.elements[runtime.elements.length - 1] ?? null
}

const updateBuildElementOperation = (
  runtime: BuildRuntime,
  id: string,
  patch: Partial<BoardElement>,
) => {
  const operation: BuildOperation = { type: 'update', id, patch }
  runtime.elements = applyBuildOperations(runtime.elements, [operation])
  runtime.operations.push(operation)
}

const executeBuildTool = async (
  settings: AIProviderSettings,
  runtime: BuildRuntime,
  toolName: BuildToolName,
  args: Record<string, unknown>,
) => {
  if (toolName === 'capture_board') {
    if (!supportsVision(settings)) {
      pushRuntimeToolEvent(runtime, 'Capture board', 'Error: Vision not supported on the model')
      return { ok: false, error: 'Error: Vision not supported on the model' }
    }
    if (!runtime.screenshotDataUrl) {
      pushRuntimeToolEvent(runtime, 'Capture board', 'Error: Board screenshot not available')
      return { ok: false, error: 'Error: Board screenshot not available' }
    }
    pushRuntimeToolEvent(runtime, 'Captured board')
    return {
      ok: true,
      screenshotAttached: true,
      note: 'Board screenshot captured and attached in runtime metadata.',
    }
  }

  if (toolName === 'get_board') {
    pushRuntimeToolEvent(runtime, 'Fetched board')
    return {
      ok: true,
      boardId: runtime.board.id,
      elements: detailedBoardSnapshot(runtime.elements),
    }
  }

  const absoluteX = (value: unknown) => clamp(asNumber(value, 0), 0, CANVAS_WIDTH)
  const absoluteY = (value: unknown) => clamp(asNumber(value, 0), 0, CANVAS_HEIGHT)

  if (toolName === 'move_mouse') {
    const targetx = absoluteX(args.targetx)
    const targety = absoluteY(args.targety)
    pushRuntimeToolEvent(runtime, 'Moved mouse', `${Math.round(targetx)}, ${Math.round(targety)}`, {
      type: 'move_mouse',
      targetx,
      targety,
    })
    return { ok: true, targetx, targety }
  }

  if (toolName === 'move_user_viewport') {
    const targetx = absoluteX(args.targetx)
    const targety = absoluteY(args.targety)
    pushRuntimeToolEvent(runtime, 'Moved viewport', `${Math.round(targetx)}, ${Math.round(targety)}`, {
      type: 'move_user_viewport',
      targetx,
      targety,
    })
    return { ok: true, targetx, targety }
  }

  if (toolName === 'wait') {
    const time = clamp(asNumber(args.time, 1), 0, 30)
    pushRuntimeToolEvent(runtime, 'Waited', `${time}s`, { type: 'wait', time })
    await sleep(time * 1000)
    return { ok: true, time }
  }

  if (toolName === 'draw_dot') {
    const targetx = absoluteX(args.targetx)
    const targety = absoluteY(args.targety)
    const thickness = Math.max(1, asNumber(args.thickness, 6))
    const created = createBuildElementOperation(runtime, {
      type: 'pen',
      x: targetx,
      y: targety,
      width: 8,
      height: 8,
      strokeWidth: thickness,
      stroke: typeof args.color === 'string' ? args.color : '#183153',
      fill: 'transparent',
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, 'Drew dot')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'draw_line' || toolName === 'draw_arrow') {
    const startx = absoluteX(args.startx)
    const starty = absoluteY(args.starty)
    const endx = absoluteX(args.endx)
    const endy = absoluteY(args.endy)
    const left = Math.min(startx, endx)
    const top = Math.min(starty, endy)
    const width = Math.max(2, Math.abs(endx - startx))
    const height = Math.max(2, Math.abs(endy - starty))
    const created = createBuildElementOperation(runtime, {
      type: toolName === 'draw_line' ? 'line' : 'arrow',
      x: left,
      y: top,
      width,
      height,
      strokeWidth: asNumber(args.thickness, 2),
      stroke: typeof args.color === 'string' ? args.color : '#183153',
      linePoints: [
        { x: startx - left, y: starty - top },
        { x: endx - left, y: endy - top },
      ],
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, toolName === 'draw_line' ? 'Drew line' : 'Drew arrow')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'draw_square' || toolName === 'draw_circle') {
    const created = createBuildElementOperation(runtime, {
      type: toolName === 'draw_square' ? 'rectangle' : 'ellipse',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(24, asNumber(args.width, 180)),
      height: Math.max(24, asNumber(args.height, 120)),
      strokeWidth: asNumber(args.thickness, 2),
      stroke: typeof args.color === 'string' ? args.color : '#183153',
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, toolName === 'draw_square' ? 'Drew square' : 'Drew circle')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'embed_link') {
    const created = createBuildElementOperation(runtime, {
      type: 'iframe',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(120, asNumber(args.width, 480)),
      height: Math.max(90, asNumber(args.height, 280)),
      src: typeof args.targetlink === 'string' ? args.targetlink : 'https://example.com',
      title: 'Embedded content',
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, 'Embedded link')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'write_text' || toolName === 'write_md') {
    const textValue = readStringArg(args, 'text', 'content', 'label', 'value')
    const kind = toolName === 'write_text' ? 'text' : 'markdown'
    const size = clamp(asNumber(args.size, kind === 'text' ? 28 : 18), 1, 50)
    const estimatedBox = estimateTextBoxSize(textValue, size, kind)
    const created = createBuildElementOperation(runtime, {
      type: kind,
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(kind === 'text' ? 28 : 120, asNumber(args.width, estimatedBox.width)),
      height: Math.max(kind === 'text' ? 24 : 52, asNumber(args.height, estimatedBox.height)),
      text: textValue,
      fontSize: size,
      stroke: 'transparent',
      fill: 'transparent',
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, toolName === 'write_text' ? 'Wrote text' : 'Wrote markdown')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'write_latex') {
    const tex = readStringArg(args, 'tex', 'latex', 'text', 'content')
    const sanitized = tex.replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}_^]/g, '').replace(/\s+/g, '')
    const created = createBuildElementOperation(runtime, {
      type: 'latex',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(96, asNumber(args.width, Math.round(28 * (Math.max(3, sanitized.length) * 0.62 + 1.8)))),
      height: Math.max(52, asNumber(args.height, 72)),
      latex: tex,
      stroke: 'transparent',
      fill: 'transparent',
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, 'Wrote LaTeX')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'write_code' || toolName === 'write_monaco') {
    const codeValue = readStringArg(args, 'code', 'text', 'content', 'value')
    const created = createBuildElementOperation(runtime, {
      type: toolName === 'write_code' ? 'code' : 'monaco',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(180, asNumber(args.width, toolName === 'write_code' ? 420 : 520)),
      height: Math.max(120, asNumber(args.height, toolName === 'write_code' ? 180 : 320)),
      code: codeValue,
      language: typeof args.language === 'string' ? args.language : 'javascript',
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, toolName === 'write_code' ? 'Wrote code block' : 'Wrote Monaco editor')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'make_graph') {
    const expression =
      typeof args.expression === 'string' && args.expression.trim()
        ? args.expression.trim()
        : 'x'
    const created = createBuildElementOperation(runtime, {
      type: 'graph',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
      width: Math.max(180, asNumber(args.width, 360)),
      height: Math.max(140, asNumber(args.height, 240)),
      xMin: asNumber(args.xmin, -8),
      xMax: asNumber(args.xmax, 8),
      yMin: asNumber(args.ymin, -5),
      yMax: asNumber(args.ymax, 5),
      expressions: [expression],
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, 'Created graph')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'add_ruler' || toolName === 'add_protractor') {
    const created = createBuildElementOperation(runtime, {
      type: toolName === 'add_ruler' ? 'ruler' : 'protractor',
      x: absoluteX(args.startx),
      y: absoluteY(args.starty),
    } as Partial<BoardElement> & { type: BoardElement['type'] })
    pushRuntimeToolEvent(runtime, toolName === 'add_ruler' ? 'Added ruler' : 'Added protractor')
    return { ok: true, id: created?.id ?? null }
  }

  if (toolName === 'move_element') {
    const id = typeof args.elementid === 'string' ? args.elementid : ''
    if (!id) return { ok: false, error: 'elementid is required.' }
    const exists = runtime.elements.find((element) => element.id === id)
    if (!exists) return { ok: false, error: `Element not found: ${id}` }
    updateBuildElementOperation(runtime, id, {
      x: absoluteX(args.targetx),
      y: absoluteY(args.targety),
    })
    pushRuntimeToolEvent(runtime, 'Moved element', id)
    return { ok: true, id }
  }

  const id = typeof args.elementid === 'string' ? args.elementid : ''
  if (!id) return { ok: false, error: 'elementid is required.' }
  const exists = runtime.elements.some((element) => element.id === id)
  if (!exists) return { ok: false, error: `Element not found: ${id}` }
  const operation: BuildOperation = { type: 'delete', id }
  runtime.elements = applyBuildOperations(runtime.elements, [operation])
  runtime.operations.push(operation)
  pushRuntimeToolEvent(runtime, 'Deleted element', id)
  return { ok: true, id }
}

const executeAskTool = async (
  settings: AIProviderSettings,
  runtime: AskRuntime,
  toolName: AskToolName,
  args: Record<string, unknown>,
) => {
  if (toolName === 'capture_board') {
    if (!supportsVision(settings)) {
      pushRuntimeToolEvent(runtime, 'Capture board', 'Error: Vision not supported on the model')
      return { ok: false, error: 'Error: Vision not supported on the model' }
    }
    if (!runtime.screenshotDataUrl) {
      pushRuntimeToolEvent(runtime, 'Capture board', 'Error: Board screenshot not available')
      return { ok: false, error: 'Error: Board screenshot not available' }
    }
    pushRuntimeToolEvent(runtime, 'Captured board')
    return {
      ok: true,
      screenshotAttached: true,
      note: 'Board screenshot captured and attached in runtime metadata.',
    }
  }

  if (toolName === 'get_board') {
    pushRuntimeToolEvent(runtime, 'Fetched board')
    return {
      ok: true,
      boardId: runtime.board.id,
      elements: detailedBoardSnapshot(runtime.elements),
    }
  }

  const absoluteX = (value: unknown) => clamp(asNumber(value, 0), 0, CANVAS_WIDTH)
  const absoluteY = (value: unknown) => clamp(asNumber(value, 0), 0, CANVAS_HEIGHT)

  if (toolName === 'move_mouse') {
    const targetx = absoluteX(args.targetx)
    const targety = absoluteY(args.targety)
    pushRuntimeToolEvent(runtime, 'Moved mouse', `${Math.round(targetx)}, ${Math.round(targety)}`, {
      type: 'move_mouse',
      targetx,
      targety,
    })
    return { ok: true, targetx, targety }
  }

  if (toolName === 'move_user_viewport') {
    const targetx = absoluteX(args.targetx)
    const targety = absoluteY(args.targety)
    pushRuntimeToolEvent(runtime, 'Moved viewport', `${Math.round(targetx)}, ${Math.round(targety)}`, {
      type: 'move_user_viewport',
      targetx,
      targety,
    })
    return { ok: true, targetx, targety }
  }

  if (toolName === 'wait') {
    const time = clamp(asNumber(args.time, 1), 0, 30)
    pushRuntimeToolEvent(runtime, 'Waited', `${time}s`, { type: 'wait', time })
    await sleep(time * 1000)
    return { ok: true, time }
  }

  const query = typeof args.string === 'string' ? args.string.trim().toLowerCase() : ''
  const matches = query
    ? runtime.elements
        .filter((element) => elementSearchText(element).includes(query))
        .map((element) => detailedBoardSnapshot([element])[0])
    : []
  pushRuntimeToolEvent(runtime, 'Searched element', query || 'empty query')
  return {
    ok: true,
    query,
    matches,
  }
}

const buildToolsForResponses = [
  {
    type: 'function',
    name: 'capture_board',
    description:
      'Capture the board currently visible to the user. Return Error: Vision not supported on the model when vision is unavailable.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_board',
    description: 'Get all current board elements with explicit coordinates and properties.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_mouse',
    description: 'Move the agent overlay mouse to targetx and targety in absolute board coordinates.',
    parameters: {
      type: 'object',
      properties: {
        targetx: { type: 'number' },
        targety: { type: 'number' },
      },
      required: ['targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_user_viewport',
    description: 'Move the user viewport so targetx and targety become the center of the visible area.',
    parameters: {
      type: 'object',
      properties: {
        targetx: { type: 'number' },
        targety: { type: 'number' },
      },
      required: ['targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'wait',
    description: 'Wait for time seconds before continuing.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'number' },
      },
      required: ['time'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draw_dot',
    description: 'Draw a dot using targetx, targety, color and thickness.',
    parameters: {
      type: 'object',
      properties: {
        targetx: { type: 'number' },
        targety: { type: 'number' },
        color: { type: 'string' },
        thickness: { type: 'number' },
      },
      required: ['targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draw_line',
    description: 'Draw a line with startx, starty, endx, endy, thickness and color.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        endx: { type: 'number' },
        endy: { type: 'number' },
        thickness: { type: 'number' },
        color: { type: 'string' },
      },
      required: ['startx', 'starty', 'endx', 'endy'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draw_arrow',
    description: 'Draw an arrow with startx, starty, endx, endy, thickness and color.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        endx: { type: 'number' },
        endy: { type: 'number' },
        thickness: { type: 'number' },
        color: { type: 'string' },
      },
      required: ['startx', 'starty', 'endx', 'endy'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draw_square',
    description: 'Draw a rectangle using startx, starty, width, height, thickness and color.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        thickness: { type: 'number' },
        color: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'draw_circle',
    description: 'Draw an ellipse using startx, starty, width, height, thickness and color.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        thickness: { type: 'number' },
        color: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'embed_link',
    description: 'Embed a link using startx, starty, width, height and targetlink.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        targetlink: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height', 'targetlink'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_text',
    description: 'Write plain text using startx, starty, width, height, text and optional size.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        text: { type: 'string' },
        size: { type: 'number' },
      },
      required: ['startx', 'starty', 'width', 'height', 'text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_md',
    description: 'Write markdown using startx, starty, width, height and text.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height', 'text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_latex',
    description: 'Write a LaTeX formula using startx, starty, width, height and tex.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        tex: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height', 'tex'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_code',
    description: 'Write a code block using startx, starty, width, height and code.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        code: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height', 'code'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_monaco',
    description: 'Write a monaco editor block using startx, starty, width, height and code.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        code: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['startx', 'starty', 'width', 'height', 'code'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'make_graph',
    description: 'Create a function graph using explicit min/max bounds, position, size and expression.',
    parameters: {
      type: 'object',
      properties: {
        xmin: { type: 'number' },
        xmax: { type: 'number' },
        ymin: { type: 'number' },
        ymax: { type: 'number' },
        startx: { type: 'number' },
        starty: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        expression: { type: 'string' },
      },
      required: ['xmin', 'xmax', 'ymin', 'ymax', 'startx', 'starty', 'width', 'height', 'expression'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'add_ruler',
    description: 'Add one ruler using startx and starty.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
      },
      required: ['startx', 'starty'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'add_protractor',
    description: 'Add one protractor using startx and starty.',
    parameters: {
      type: 'object',
      properties: {
        startx: { type: 'number' },
        starty: { type: 'number' },
      },
      required: ['startx', 'starty'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_element',
    description: 'Move an existing element using elementid, targetx and targety.',
    parameters: {
      type: 'object',
      properties: {
        elementid: { type: 'string' },
        targetx: { type: 'number' },
        targety: { type: 'number' },
      },
      required: ['elementid', 'targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_element',
    description: 'Delete an element using elementid.',
    parameters: {
      type: 'object',
      properties: {
        elementid: { type: 'string' },
      },
      required: ['elementid'],
      additionalProperties: false,
    },
  },
]

const askToolsForResponses = [
  {
    type: 'function',
    name: 'capture_board',
    description:
      'Capture the board currently visible to the user. Return Error: Vision not supported on the model when vision is unavailable.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_board',
    description: 'Get all board elements with explicit coordinates and fields.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_mouse',
    description: 'Move the agent overlay mouse to targetx and targety in absolute board coordinates.',
    parameters: {
      type: 'object',
      properties: {
        targetx: { type: 'number' },
        targety: { type: 'number' },
      },
      required: ['targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_user_viewport',
    description: 'Move the user viewport so targetx and targety become the center of the visible area.',
    parameters: {
      type: 'object',
      properties: {
        targetx: { type: 'number' },
        targety: { type: 'number' },
      },
      required: ['targetx', 'targety'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'wait',
    description: 'Wait for time seconds before continuing.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'number' },
      },
      required: ['time'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_element',
    description: 'Search board elements by id, type, text or related fields.',
    parameters: {
      type: 'object',
      properties: {
        string: { type: 'string' },
      },
      required: ['string'],
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

const askToolsForCompletions = askToolsForResponses.map((tool) => ({
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

const askToolsForGemini = [
  {
    functionDeclarations: askToolsForResponses.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.parameters),
    })),
  },
]

const defaultBuildSystemPrompt =
  'You are Whiteboard Pro Build mode agent. Use tool calls to modify the board and provide a brief final summary.'

const finalizeBuildMessage = (message: string, operationCount: number) => {
  const normalized = message.trim()
  if (operationCount === 0) {
    return normalized || 'No board changes were applied.'
  }
  return normalized || `Applied ${operationCount} change${operationCount === 1 ? '' : 's'}.`
}

const buildPromptPath = path.join(process.cwd(), 'system-build.md')
const askPromptPath = path.join(process.cwd(), 'system-ask.md')
const insertPromptPath = path.join(process.cwd(), 'system-insert.md')
const defaultAskSystemPrompt =
  'You are Whiteboard Pro assistant. Answer in concise English based on the provided whiteboard state only. If the board does not contain enough information, say so clearly.'
const defaultInsertSystemPrompt =
  'You are Whiteboard Pro Insert mode agent. Add exactly one new element with a tool call and provide a brief summary.'

export const getBuildSystemPrompt = () => {
  try {
    const text = fs.readFileSync(buildPromptPath, 'utf8').trim()
    return text || defaultBuildSystemPrompt
  } catch {
    return defaultBuildSystemPrompt
  }
}

const getAskSystemPrompt = () => {
  try {
    const text = fs.readFileSync(askPromptPath, 'utf8').trim()
    return text || defaultAskSystemPrompt
  } catch {
    return defaultAskSystemPrompt
  }
}

const getInsertSystemPrompt = () => {
  try {
    const text = fs.readFileSync(insertPromptPath, 'utf8').trim()
    return text || defaultInsertSystemPrompt
  } catch {
    return defaultInsertSystemPrompt
  }
}

const normalizeBuildResult = (
  board: Board,
  runtime: BuildRuntime,
  mode: 'build' | 'insert',
) => {
  if (mode !== 'insert') {
    return {
      operations: runtime.operations,
      elements: runtime.elements,
    }
  }
  const firstCreate = runtime.operations.find((operation) => operation.type === 'create')
  const operations = firstCreate ? [firstCreate] : []
  return {
    operations,
    elements: applyBuildOperations(board.elements, operations),
  }
}

const buildUserPrompt = (
  board: Board,
  selectedElementId: string | undefined,
  prompt: string,
  viewOrigin: Point,
  viewBounds: Rect | undefined,
  history: AgentConversationMessage[],
) =>
  [
    `Board context: ${JSON.stringify(boardContext(board, selectedElementId, viewOrigin, viewBounds), null, 2)}`,
    history.length > 0
      ? `Conversation history:\n${history
          .map((message) => `[${message.role}] ${message.content}`)
          .join('\n\n')}`
      : '',
    `User request: ${prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n')

const buildAskPrompt = (
  board: Board,
  selectedElementId: string | undefined,
  question: string,
  viewOrigin: Point,
  viewBounds: Rect | undefined,
  history: AgentConversationMessage[],
) =>
  [
    `Board context: ${JSON.stringify(boardContext(board, selectedElementId, viewOrigin, viewBounds), null, 2)}`,
    history.length > 0
      ? `Conversation history:\n${history
          .map((message) => `[${message.role}] ${message.content}`)
          .join('\n\n')}`
      : '',
    `User question: ${question}`,
    'Use tools when they help. Do not invent board state.',
  ]
    .filter(Boolean)
    .join('\n\n')

const runOpenAIAskTools = async (
  settings: AIProviderSettings,
  runtime: AskRuntime,
  prompt: string,
  systemPrompt: string,
) => {
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
      await throwRequestError('OpenAI', response)
    }
    return (await response.json()) as Record<string, unknown>
  }

  let payload = await request({
    model: settings.modelId,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: prompt }] },
    ],
    tools: askToolsForResponses,
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
      return text
    }

    const outputs = []
    for (const call of calls) {
      const name = readAskToolName(call.name)
      const args = parseJsonObject(call.arguments)
      const result = name
        ? await executeAskTool(settings, runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      outputs.push({
        type: 'function_call_output',
        call_id: typeof call.call_id === 'string' ? call.call_id : nanoid(),
        output: JSON.stringify(result),
      })
    }

    payload = await request({
      model: settings.modelId,
      previous_response_id: responseId || undefined,
      input: outputs,
      tools: askToolsForResponses,
      tool_choice: 'auto',
    })
  }

  return ''
}

const runCompatibleAskTools = async (
  settings: AIProviderSettings,
  runtime: AskRuntime,
  prompt: string,
  systemPrompt: string,
) => {
  const baseUrl = settings.baseUrl.replace(/\/$/, '')
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
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
        tools: askToolsForCompletions,
        tool_choice: 'auto',
      }),
    })
    if (!response.ok) {
      await throwRequestError('Compatible API', response)
    }
    const payload = (await response.json()) as Record<string, unknown>
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const message =
      choices[0] && typeof choices[0] === 'object'
        ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined)
        : undefined
    if (!message) break

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (toolCalls.length === 0) {
      return extractText(message.content).trim()
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
      const name = readAskToolName(fn.name)
      const args = parseJsonObject(fn.arguments)
      const result = name
        ? await executeAskTool(settings, runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      messages.push({
        role: 'tool',
        tool_call_id: typeof record.id === 'string' ? record.id : nanoid(),
        content: JSON.stringify(result),
      })
    }
  }

  return ''
}

const runGeminiAskTools = async (
  settings: AIProviderSettings,
  runtime: AskRuntime,
  prompt: string,
  systemPrompt: string,
) => {
  const contents: Array<Record<string, unknown>> = [{ role: 'user', parts: [{ text: prompt }] }]

  for (let turn = 0; turn < 24; turn += 1) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelId}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: askToolsForGemini,
          contents,
        }),
      },
    )
    if (!response.ok) {
      await throwRequestError('Gemini', response)
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
      return extractText(parts).trim() || extractText(candidate).trim()
    }

    contents.push({ role: 'model', parts })

    const responseParts: Array<Record<string, unknown>> = []
    for (const part of functionParts) {
      const fc = part.functionCall as Record<string, unknown>
      const name = readAskToolName(fc.name)
      const args = parseJsonObject(fc.args)
      const result = name
        ? await executeAskTool(settings, runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      responseParts.push({
        functionResponse: {
          name: typeof fc.name === 'string' ? fc.name : 'unknown_tool',
          response: result,
        },
      })
    }
    contents.push({ role: 'user', parts: responseParts })
  }

  return ''
}

export const runAskWithToolCalls = async (
  settings: AIProviderSettings,
  board: Board,
  question: string,
  selectedElementId?: string,
  viewOrigin?: Point,
  viewBounds?: Rect,
  screenshotDataUrl?: string,
  history: AgentConversationMessage[] = [],
): Promise<AgentAskResponse> => {
  ensureConfigured(settings)
  const startedAt = Date.now()
  const runtime: AskRuntime = {
    board,
    selectedElementId,
    viewOrigin: viewOrigin ?? { x: 0, y: 0 },
    elements: [...board.elements],
    screenshotDataUrl,
    toolEvents: [],
  }
  const systemPrompt = getAskSystemPrompt()
  const userPrompt = buildAskPrompt(board, selectedElementId, question, runtime.viewOrigin, viewBounds, history)

  let answer = ''
  if (settings.providerType === 'openai') {
    answer = await runOpenAIAskTools(settings, runtime, userPrompt, systemPrompt)
  } else if (settings.providerType === 'compatible') {
    answer = await runCompatibleAskTools(settings, runtime, userPrompt, systemPrompt)
  } else if (settings.providerType === 'gemini') {
    answer = await runGeminiAskTools(settings, runtime, userPrompt, systemPrompt)
  } else {
    throw new Error('Unsupported provider.')
  }

  return {
    answer: answer.trim() || 'AI provider returned an empty response.',
    toolEvents: runtime.toolEvents,
    thoughtSeconds: Math.max(0.1, (Date.now() - startedAt) / 1000),
  }
}

const runOpenAIToolCalls = async (
  settings: AIProviderSettings,
  runtime: BuildRuntime,
  prompt: string,
  systemPrompt: string,
) => {
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
      await throwRequestError('OpenAI', response)
    }
    return (await response.json()) as Record<string, unknown>
  }

  let payload = await request({
    model: settings.modelId,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
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
      return finalizeBuildMessage(text, runtime.operations.length)
    }

    const outputs = []
    for (const call of calls) {
      const name = readBuildToolName(call.name)
      const args = parseJsonObject(call.arguments)
      const result = name
        ? await executeBuildTool(settings, runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      outputs.push({
        type: 'function_call_output',
        call_id: typeof call.call_id === 'string' ? call.call_id : nanoid(),
        output: JSON.stringify(result),
      })
    }

    payload = await request({
      model: settings.modelId,
      previous_response_id: responseId || undefined,
      input: outputs,
      tools: buildToolsForResponses,
      tool_choice: 'auto',
    })
  }

  return finalizeBuildMessage('', runtime.operations.length)
}

const runCompatibleToolCalls = async (
  settings: AIProviderSettings,
  runtime: BuildRuntime,
  prompt: string,
  systemPrompt: string,
) => {
  const baseUrl = settings.baseUrl.replace(/\/$/, '')
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
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
      await throwRequestError('Compatible API', response)
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
      return finalizeBuildMessage(text, runtime.operations.length)
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
      const name = readBuildToolName(fn.name)
      const args = parseJsonObject(fn.arguments)
      const result = name
        ? await executeBuildTool(settings, runtime, name, args)
        : { ok: false, error: 'Unknown tool name.' }
      messages.push({
        role: 'tool',
        tool_call_id: typeof record.id === 'string' ? record.id : nanoid(),
        content: JSON.stringify(result),
      })
    }
  }

  return finalizeBuildMessage('', runtime.operations.length)
}

const runGeminiToolCalls = async (
  settings: AIProviderSettings,
  runtime: BuildRuntime,
  prompt: string,
  systemPrompt: string,
) => {
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
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: buildToolsForGemini,
          contents,
        }),
      },
    )
    if (!response.ok) {
      await throwRequestError('Gemini', response)
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
      return finalizeBuildMessage(text, runtime.operations.length)
    }

    contents.push({
      role: 'model',
      parts,
    })

    const responseParts: Array<Record<string, unknown>> = []
    for (const part of functionParts) {
      const fc = part.functionCall as Record<string, unknown>
      const name = readBuildToolName(fc.name)
      const args = parseJsonObject(fc.args)
      const result = name
        ? await executeBuildTool(settings, runtime, name, args)
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

  return finalizeBuildMessage('', runtime.operations.length)
}

export const runBuildWithToolCalls = async (
  settings: AIProviderSettings,
  board: Board,
  prompt: string,
  mode: 'build' | 'insert' = 'build',
  selectedElementId?: string,
  viewOrigin?: Point,
  viewBounds?: Rect,
  screenshotDataUrl?: string,
  history: AgentConversationMessage[] = [],
): Promise<AgentBuildResponse> => {
  ensureConfigured(settings)
  const startedAt = Date.now()
  const runtime: BuildRuntime = {
    board,
    selectedElementId,
    viewOrigin: viewOrigin ?? { x: 0, y: 0 },
    elements: [...board.elements],
    screenshotDataUrl,
    toolEvents: [],
    operations: [],
  }
  const systemPrompt = mode === 'insert' ? getInsertSystemPrompt() : getBuildSystemPrompt()
  const userPrompt = buildUserPrompt(board, selectedElementId, prompt, runtime.viewOrigin, viewBounds, history)

  let message = ''
  if (settings.providerType === 'openai') {
    message = await runOpenAIToolCalls(settings, runtime, userPrompt, systemPrompt)
  } else if (settings.providerType === 'compatible') {
    message = await runCompatibleToolCalls(settings, runtime, userPrompt, systemPrompt)
  } else if (settings.providerType === 'gemini') {
    message = await runGeminiToolCalls(settings, runtime, userPrompt, systemPrompt)
  } else {
    throw new Error('Unsupported provider.')
  }

  const normalized = normalizeBuildResult(board, runtime, mode)

  return {
    message,
    operations: normalized.operations,
    elements: normalized.elements,
    toolEvents: runtime.toolEvents,
    thoughtSeconds: Math.max(0.1, (Date.now() - startedAt) / 1000),
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
      toolEvents: [],
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
      toolEvents: [],
    }
  } catch {
    return {
      message: 'AI response JSON could not be parsed. No changes were applied.',
      operations: [],
      elements: currentElements,
      toolEvents: [],
    }
  }
}
