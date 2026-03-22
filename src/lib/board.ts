import katex from 'katex'
import { marked } from 'marked'
import { nanoid } from 'nanoid'
import type {
  Asset,
  AssetElement,
  BoardElement,
  CodeElement,
  CompassElement,
  GraphElement,
  LatexElement,
  MonacoElement,
  PenElement,
  Point,
  ProtractorElement,
  RulerElement,
  TextElement,
  ToolId,
} from '../../shared/types.ts'

const now = () => new Date().toISOString()
const LATEX_BASE_FONT_SIZE = 34
const TEXT_BASE_FONT_SIZE = 28
const MARKDOWN_BASE_FONT_SIZE = 18
const COMPASS_WIDTH = 400
const COMPASS_HEIGHT = 560
const COMPASS_DEFAULT_SPREAD = 220
export const SHAPE_MIN_SIZE = 16

const estimateLatexTextLength = (latex: string) =>
  Math.max(
    3,
    latex
      .replace(/\\[a-zA-Z]+/g, 'x')
      .replace(/[{}_^]/g, '')
      .replace(/\s+/g, '')
      .length,
  )

const getLatexBoxSize = (latex: string, fontSize: number) => {
  const textUnits = estimateLatexTextLength(latex)
  return {
    width: Math.max(72, Math.round(fontSize * (textUnits * 0.62 + 1.35))),
    height: Math.max(42, Math.round(fontSize * 1.95)),
  }
}

const baseElement = <T extends ToolId>(
  type: T,
  x: number,
  y: number,
  width: number,
  height: number,
  zIndex: number,
) => ({
  id: nanoid(),
  type,
  x,
  y,
  width,
  height,
  rotation: 0,
  stroke: '#183153',
  fill: 'rgba(255,255,255,0.55)',
  strokeWidth: 2,
  zIndex,
  createdAt: now(),
  updatedAt: now(),
})

export const normalizeRect = (a: Point, b: Point, minWidth = 0, minHeight = minWidth) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const width = Math.max(Math.abs(dx), minWidth)
  const height = Math.max(Math.abs(dy), minHeight)
  const x = dx < 0 ? a.x - width : a.x
  const y = dy < 0 ? a.y - height : a.y
  return { x, y, width, height }
}

export const createShapeElement = (
  type: 'line' | 'arrow' | 'rectangle' | 'ellipse',
  start: Point,
  end: Point,
  zIndex: number,
  options?: { fill?: string; stroke?: string },
): BoardElement => {
  if (type === 'line' || type === 'arrow') {
    const padding = 12
    const x = Math.min(start.x, end.x) - padding
    const y = Math.min(start.y, end.y) - padding
    const width = Math.max(1, Math.abs(end.x - start.x)) + padding * 2
    const height = Math.max(1, Math.abs(end.y - start.y)) + padding * 2
    return {
      ...baseElement(type, x, y, width, height, zIndex),
      stroke: options?.stroke ?? '#183153',
      fill: 'transparent',
      linePoints: [
        { x: start.x - x, y: start.y - y },
        { x: end.x - x, y: end.y - y },
      ],
    }
  }

  const { x, y, width, height } = normalizeRect(start, end, SHAPE_MIN_SIZE, SHAPE_MIN_SIZE)
  return {
    ...baseElement(type, x, y, width, height, zIndex),
    stroke: options?.stroke ?? '#183153',
    fill: options?.fill ?? 'transparent',
  }
}

export const createPenElement = (
  points: Point[],
  zIndex: number,
  options?: { stroke?: string; strokeWidth?: number },
): PenElement => {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(8, Math.max(...xs) - x)
  const height = Math.max(8, Math.max(...ys) - y)
  return {
    ...baseElement('pen', x, y, width, height, zIndex),
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
    stroke: options?.stroke ?? '#183153',
    strokeWidth: options?.strokeWidth ?? 1,
    fill: 'transparent',
  }
}

export const createPlacedElement = (
  type: Exclude<
    ToolId,
    'select' | 'pen' | 'line' | 'arrow' | 'rectangle' | 'ellipse'
  >,
  point: Point,
  zIndex: number,
  payload?: { asset?: Asset; src?: string; title?: string },
): BoardElement => {
  switch (type) {
    case 'iframe':
      return {
        ...baseElement('iframe', point.x, point.y, 480, 280, zIndex),
        src: payload?.src ?? 'https://example.com',
        title: payload?.title ?? 'Embedded content',
      }
    case 'image':
    case 'video':
    case 'file':
      return {
        ...baseElement(type, point.x, point.y, type === 'file' ? 280 : 320, type === 'file' ? 96 : 220, zIndex),
        assetId: payload?.asset?.id ?? nanoid(),
        name: payload?.asset?.name ?? `${type} asset`,
        src: payload?.asset?.sourceUrl ?? '',
        mimeType: payload?.asset?.mimeType ?? 'application/octet-stream',
        fill: type === 'file' ? 'rgba(246, 231, 201, 0.95)' : 'rgba(255,255,255,0.92)',
      } satisfies AssetElement
    case 'compass':
      return {
        ...baseElement('compass', point.x - COMPASS_WIDTH / 2, point.y - COMPASS_HEIGHT / 2, COMPASS_WIDTH, COMPASS_HEIGHT, zIndex),
        radius: COMPASS_DEFAULT_SPREAD,
        startAngle: 0,
        endAngle: 359.8584,
        fill: 'transparent',
      } satisfies CompassElement
    case 'graph':
      return {
        ...baseElement('graph', point.x, point.y, 360, 240, zIndex),
        unit: 20,
        xMin: -8,
        xMax: 8,
        yMin: -5,
        yMax: 5,
        expressions: ['x'],
      } satisfies GraphElement
    case 'text':
      return {
        ...baseElement(type, point.x, point.y, 180, 60, zIndex),
        text: '',
        fontSize: TEXT_BASE_FONT_SIZE,
        fill: 'transparent',
        stroke: 'transparent',
      } satisfies TextElement
    case 'markdown':
      return {
        ...baseElement('markdown', point.x, point.y, 360, 220, zIndex),
        text: '# Markdown\n\n- item 1\n- item 2',
        fontSize: MARKDOWN_BASE_FONT_SIZE,
        fill: 'transparent',
        stroke: 'transparent',
      } satisfies TextElement
    case 'code':
      return {
        ...baseElement('code', point.x, point.y, 420, 180, zIndex),
        code: "const sum = (a, b) => a + b\nconsole.log(sum(2, 3))",
        language: 'javascript',
        fill: '#eef1f4',
        stroke: 'transparent',
      } satisfies CodeElement
    case 'monaco':
      return {
        ...baseElement('monaco', point.x, point.y, 520, 320, zIndex),
        code: "function greet(name) {\n  return `Hello, ${name}`\n}\n\nconsole.log(greet('Whiteboard Pro'))",
        language: 'javascript',
        fill: '#eef1f4',
      } satisfies MonacoElement
    case 'latex':
      const fontSize = LATEX_BASE_FONT_SIZE
      const { width, height } = getLatexBoxSize('f(x)=x^2+3x+2', fontSize)
      return {
        ...baseElement('latex', point.x, point.y, width, height, zIndex),
        latex: 'f(x)=x^2+3x+2',
        fontSize,
        fill: 'transparent',
      } satisfies LatexElement
    case 'ruler':
      return {
        ...baseElement('ruler', point.x, point.y, 720, 96, zIndex),
        units: 18,
        fill: 'rgba(242, 204, 97, 0.35)',
      } satisfies RulerElement
    case 'protractor':
      return {
        ...baseElement('protractor', point.x, point.y, 280, 150, zIndex),
        fill: 'rgba(82, 174, 215, 0.18)',
      } satisfies ProtractorElement
    default:
      throw new Error(`Unsupported placement tool: ${type satisfies never}`)
  }
}

export const translateElement = (
  element: BoardElement,
  dx: number,
  dy: number,
): BoardElement => ({
  ...element,
  x: element.x + dx,
  y: element.y + dy,
  updatedAt: now(),
})

export const resizeElement = (
  element: BoardElement,
  width: number,
  height: number,
): BoardElement => {
  if (element.type === 'ruler') {
    return {
      ...element,
      updatedAt: now(),
    }
  }

  if (element.type === 'protractor') {
    const aspect = Math.max(0.2, element.width / Math.max(1, element.height))
    const baseWidth = Math.max(80, width)
    const adjustedHeight = Math.max(42, baseWidth / aspect)
    return {
      ...element,
      width: baseWidth,
      height: adjustedHeight,
      updatedAt: now(),
    }
  }

  if (element.type === 'latex') {
    const nextWidth = Math.max(72, width)
    const nextHeight = Math.max(42, height)
    const widthScale = nextWidth / Math.max(1, element.width)
    const heightScale = nextHeight / Math.max(1, element.height)
    const scale = Math.max(0.5, Math.min(4, Math.max(widthScale, heightScale)))
    const fontSize = Math.max(24, Math.min(144, Math.round(element.fontSize * scale)))
    const box = getLatexBoxSize(element.latex, fontSize)
    return {
      ...element,
      width: box.width,
      height: box.height,
      fontSize,
      updatedAt: now(),
    }
  }

  if (element.type === 'text' || element.type === 'markdown') {
    const nextWidth = Math.max(28, width)
    const nextHeight = Math.max(24, height)
    return {
      ...element,
      width: nextWidth,
      height: nextHeight,
      updatedAt: now(),
    }
  }

  const minSize =
    element.type === 'rectangle' || element.type === 'ellipse'
      ? SHAPE_MIN_SIZE
      : element.type === 'line' || element.type === 'arrow'
        ? 0
        : 24
  const next = {
    ...element,
    width: Math.max(minSize, width),
    height: Math.max(minSize, height),
    updatedAt: now(),
  }

  if (next.type === 'compass') {
    next.width = element.width
    next.height = element.height
  }

  return next
}

export const updateElement = (
  element: BoardElement,
  patch: Partial<Omit<BoardElement, 'id' | 'type'>>,
): BoardElement => ({
  ...element,
  ...patch,
  updatedAt: now(),
})

export const renderLatexToHtml = (latex: string) => {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
    })
  } catch {
    return katex.renderToString('\\text{Invalid\\ LaTeX}', {
      throwOnError: false,
      displayMode: true,
    })
  }
}

export const renderMarkdownToHtml = (markdown: string) => {
  marked.setOptions({
    gfm: true,
    breaks: true,
  })
  const source = markdown?.trim() ? markdown : '# Markdown'
  return marked.parse(source, { async: false }) as string
}

export const describeElement = (element: BoardElement) => {
  switch (element.type) {
    case 'pen':
      return 'Freehand stroke'
    case 'line':
      return 'Line'
    case 'text':
      return 'Text box'
    case 'markdown':
      return 'Markdown box'
    case 'code':
      return 'Code block'
    case 'monaco':
      return 'Monaco editor'
    case 'arrow':
      return 'Arrow'
    case 'rectangle':
      return 'Rectangle'
    case 'ellipse':
      return 'Circle / ellipse'
    case 'iframe':
      return `Embed: ${element.title}`
    case 'image':
      return `Image: ${element.name}`
    case 'video':
      return `Video: ${element.name}`
    case 'file':
      return `File: ${element.name}`
    case 'compass':
      return 'Compass'
    case 'graph':
      return 'Coordinate graph'
    case 'latex':
      return 'LaTeX formula'
    case 'ruler':
      return 'Ruler'
    case 'protractor':
      return 'Protractor'
    default:
      return 'Element'
  }
}

export const scalePoints = (points: Point[], width: number, height: number) => {
  const maxX = Math.max(1, ...points.map((point) => point.x))
  const maxY = Math.max(1, ...points.map((point) => point.y))
  return points.map((point) => ({
    x: (point.x / maxX) * width,
    y: (point.y / maxY) * height,
  }))
}

const pointHit = (point: Point, eraserPoints: Point[], radius: number) => {
  const radius2 = radius * radius
  for (const eraserPoint of eraserPoints) {
    const dx = point.x - eraserPoint.x
    const dy = point.y - eraserPoint.y
    if (dx * dx + dy * dy <= radius2) {
      return true
    }
  }
  return false
}

const splitPenByEraser = (
  pen: PenElement,
  eraserPoints: Point[],
  radius: number,
) => {
  const absolutePoints = pen.points.map((point) => ({
    x: pen.x + point.x,
    y: pen.y + point.y,
  }))

  const sampleStep = 1
  const densePoints: Point[] = []
  for (let index = 0; index < absolutePoints.length; index += 1) {
    const current = absolutePoints[index]
    densePoints.push(current)
    if (index === absolutePoints.length - 1) continue
    const next = absolutePoints[index + 1]
    const dx = next.x - current.x
    const dy = next.y - current.y
    const dist = Math.hypot(dx, dy)
    if (dist <= sampleStep) continue
    const steps = Math.floor(dist / sampleStep)
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      densePoints.push({
        x: current.x + dx * t,
        y: current.y + dy * t,
      })
    }
  }

  const hasHit = densePoints.some((point) => pointHit(point, eraserPoints, radius))
  if (!hasHit) {
    return { changed: false, segments: [pen] as PenElement[] }
  }

  const chunks: Point[][] = []
  let currentChunk: Point[] = []
  for (const point of densePoints) {
    if (pointHit(point, eraserPoints, radius)) {
      if (currentChunk.length >= 1) {
        chunks.push(currentChunk)
      }
      currentChunk = []
      continue
    }
    currentChunk.push(point)
  }
  if (currentChunk.length >= 1) {
    chunks.push(currentChunk)
  }

  const chunkLength = (chunk: Point[]) => {
    let total = 0
    for (let index = 1; index < chunk.length; index += 1) {
      total += Math.hypot(chunk[index].x - chunk[index - 1].x, chunk[index].y - chunk[index - 1].y)
    }
    return total
  }

  const chunkBounds = (chunk: Point[]) => {
    const xs = chunk.map((point) => point.x)
    const ys = chunk.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return {
      width: maxX - minX,
      height: maxY - minY,
      maxExtent: Math.max(maxX - minX, maxY - minY),
    }
  }

  const nearPoint = (a: Point, b: Point, threshold: number) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= threshold

  const smoothChunk = (chunk: Point[]) => {
    if (chunk.length < 3) {
      return chunk
    }
    const smoothed: Point[] = [chunk[0]]
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const a = chunk[index]
      const b = chunk[index + 1]
      smoothed.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
      })
      smoothed.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
      })
    }
    smoothed.push(chunk[chunk.length - 1])
    return smoothed
  }

  // Remove tiny leftovers so erasing looks clean instead of leaving dot artifacts.
  const minSegmentLength = Math.max(3, pen.strokeWidth * 2.2, radius * 0.7)
  const tailKeepLength = Math.max(1.2, pen.strokeWidth * 0.9)
  const internalMinLength = Math.max(minSegmentLength, radius * 1.15, pen.strokeWidth * 3.2)
  const internalMinExtent = Math.max(2.4, pen.strokeWidth * 1.8, radius * 0.45)
  const originalStart = absolutePoints[0]
  const originalEnd = absolutePoints[absolutePoints.length - 1]
  const segments = chunks
    .filter((chunk) => {
      if (chunk.length < 2) return false
      const length = chunkLength(chunk)
      const bounds = chunkBounds(chunk)
      // Keep short tails connected to original stroke ends.
      const head = chunk[0]
      const tail = chunk[chunk.length - 1]
      const touchesStart = nearPoint(head, originalStart, 1.8) || nearPoint(tail, originalStart, 1.8)
      const touchesEnd = nearPoint(head, originalEnd, 1.8) || nearPoint(tail, originalEnd, 1.8)
      if (touchesStart || touchesEnd) {
        return length >= tailKeepLength
      }
      // Internal leftovers need stricter thresholds to avoid thin artifacts in the middle.
      return length >= internalMinLength && bounds.maxExtent >= internalMinExtent
    })
    .map((chunk) => {
      const next = createPenElement(smoothChunk(chunk), pen.zIndex)
      return {
        ...next,
        stroke: pen.stroke,
        strokeWidth: pen.strokeWidth,
        fill: pen.fill,
        rotation: pen.rotation,
      } satisfies PenElement
    })

  return { changed: true, segments }
}

export const eraseElementsWithEraser = (
  elements: BoardElement[],
  eraserPoints: Point[],
  radius: number,
) => {
  let changed = false
  const next: BoardElement[] = []

  for (const element of elements) {
    if (element.type !== 'pen') {
      next.push(element)
      continue
    }
    const result = splitPenByEraser(element, eraserPoints, radius)
    if (result.changed) {
      changed = true
    }
    next.push(...result.segments)
  }

  if (!changed) {
    return elements
  }

  return next.map((element, index) => ({
    ...element,
    zIndex: index + 1,
  }))
}
