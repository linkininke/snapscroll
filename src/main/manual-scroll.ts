import { Jimp } from 'jimp'
import type { Rect } from './scroll-stitch'
import { captureRegionFast, type RawFrame } from './capture-fast'

export type { Rect }

type Frame = RawFrame

type TipMatch = {
  /** 画布底端条带在新帧中的 y */
  y: number
  score: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 比较时避开左右边（头像 / 滚动条），降低微信白底误匹配 */
function contentXRange(width: number): { x0: number; x1: number } {
  const x0 = Math.min(Math.floor(width * 0.12), 72)
  const x1 = Math.max(x0 + 40, width - Math.min(Math.floor(width * 0.08), 28))
  return { x0, x1 }
}

function bandDiff(
  aData: Buffer,
  aW: number,
  aY: number,
  bData: Buffer,
  bW: number,
  bY: number,
  band: number,
  x0: number,
  x1: number
): number {
  const sampleX = Math.max(1, Math.floor((x1 - x0) / 48))
  const sampleY = Math.max(1, Math.floor(band / 10))
  let err = 0
  let count = 0
  for (let y = 0; y < band; y += sampleY) {
    for (let x = x0; x < x1; x += sampleX) {
      const ai = ((aY + y) * aW + x) * 4
      const bi = ((bY + y) * bW + x) * 4
      err +=
        Math.abs(aData[ai]! - bData[bi]!) +
        Math.abs(aData[ai + 1]! - bData[bi + 1]!) +
        Math.abs(aData[ai + 2]! - bData[bi + 2]!)
      count++
    }
  }
  return count === 0 ? 999 : err / count
}

function rowLuma(data: Buffer, width: number, y: number, x0: number, x1: number): number {
  const sampleX = Math.max(1, Math.floor((x1 - x0) / 40))
  let sum = 0
  let n = 0
  for (let x = x0; x < x1; x += sampleX) {
    const i = (y * width + x) * 4
    sum += (data[i]! * 3 + data[i + 1]! * 4 + data[i + 2]!) / 8
    n++
  }
  return n === 0 ? 255 : sum / n
}

/** 去掉整行近黑（contentProtection / 叠层黑条） */
function trimBlackEdges(data: Buffer, width: number, y0: number, rows: number): { y0: number; rows: number } {
  const { x0, x1 } = contentXRange(width)
  let start = y0
  let end = y0 + rows
  while (start < end && rowLuma(data, width, start, x0, x1) < 22) start++
  while (end > start && rowLuma(data, width, end - 1, x0, x1) < 22) end--
  return { y0: start, rows: Math.max(0, end - start) }
}

/**
 * 把「已拼画布」最底部条带，在新帧里定位。
 * 找到后：新帧 y+band 以下就是要追加的新内容。
 */
function matchCanvasTip(
  canvas: Buffer,
  canvasW: number,
  canvasH: number,
  frame: Frame,
  band: number
): TipMatch | null {
  if (canvasH < band + 4 || frame.height < band + 4) return null
  if (canvasW !== frame.width) return null

  const { x0, x1 } = contentXRange(canvasW)
  const tipY = canvasH - band
  // 新内容一般在帧的中下部出现；仍允许搜全高（除顶栏）
  const topGuard = Math.max(36, Math.floor(frame.height * 0.1))
  const yMax = frame.height - band

  let bestScore = Number.POSITIVE_INFINITY
  let bestY = -1
  const coarse = Math.max(1, Math.floor((yMax - topGuard) / 100))

  for (let y = topGuard; y <= yMax; y += coarse) {
    const score = bandDiff(canvas, canvasW, tipY, frame.data, frame.width, y, band, x0, x1)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
    if (score < 2.5) break
  }
  if (bestY < 0) return null

  const refineFrom = Math.max(topGuard, bestY - coarse)
  const refineTo = Math.min(yMax, bestY + coarse)
  for (let y = refineFrom; y <= refineTo; y++) {
    const score = bandDiff(canvas, canvasW, tipY, frame.data, frame.width, y, band, x0, x1)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  // 第二道：再往上取一条验证
  const band2 = Math.min(band, 20)
  const tipY2 = Math.max(0, tipY - Math.floor(band * 1.5))
  const expectY2 = bestY - (tipY - tipY2)
  if (expectY2 >= 0 && expectY2 + band2 <= frame.height) {
    const s2 = bandDiff(canvas, canvasW, tipY2, frame.data, frame.width, expectY2, band2, x0, x1)
    if (s2 > bestScore + 12 && s2 > 16) return null
  }

  if (bestScore > 14) return null
  return { y: bestY, score: bestScore }
}

function framesScrollDelta(prev: Frame, next: Frame): TipMatch & { delta: number } | null {
  // 用 prev 底部当 tip，在 next 中找 → delta = tipY - matchY
  const band = Math.min(32, Math.max(18, Math.floor(prev.height / 12)))
  const m = matchCanvasTip(prev.data, prev.width, prev.height, next, band)
  if (!m) return null
  const tipY = prev.height - band
  const delta = tipY - m.y
  if (delta < 1) return null
  return { ...m, delta }
}

/**
 * 以画布底端对齐拼接：每帧只追加「底端匹配点以下」的新像素。
 * 误差不沿帧链累积；并剔除近黑行，避免黑线断层。
 */
export async function stitchFrames(frames: Frame[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error('没有捕获到画面')

  const first = frames[0]!
  const width = first.width
  const rowBytes = width * 4
  const band = Math.min(36, Math.max(20, Math.floor(first.height / 10)))

  let capacity = first.height
  for (let i = 1; i < frames.length; i++) capacity += frames[i]!.height
  const maxH = 30000
  capacity = Math.min(capacity, maxH)

  let out = Buffer.alloc(capacity * rowBytes)
  // 首帧也去掉底边可能的黑条
  const firstTrim = trimBlackEdges(first.data, width, 0, first.height)
  first.data.copy(
    out,
    0,
    firstTrim.y0 * rowBytes,
    (firstTrim.y0 + firstTrim.rows) * rowBytes
  )
  let outH = firstTrim.rows
  if (outH < 8) {
    first.data.copy(out, 0, 0, first.height * rowBytes)
    outH = first.height
  }

  const minNew = Math.max(6, Math.floor(first.height * 0.015))

  for (let i = 1; i < frames.length; i++) {
    const curr = frames[i]!
    if (curr.width !== width) continue

    const match = matchCanvasTip(out, width, outH, curr, band)
    if (!match) continue

    // 匹配到 tip 后，从 tip 对齐位置往下全是「相对画布」的内容；
    // 其中 band 行已在画布上，只追加其后的新行。
    let appendY = match.y + band
    let appendRows = curr.height - appendY
    if (appendRows < minNew) continue
    if (match.score > 12 && appendRows < Math.floor(curr.height * 0.05)) continue

    const trimmed = trimBlackEdges(curr.data, width, appendY, appendRows)
    appendY = trimmed.y0
    appendRows = trimmed.rows
    if (appendRows < minNew) continue

    if (outH + appendRows > maxH) {
      throw new Error('长图过高，请缩短滚动范围后再试')
    }
    if (outH + appendRows > capacity) {
      const grown = Buffer.alloc(Math.min(maxH, Math.max(outH + appendRows, capacity * 2)) * rowBytes)
      out.copy(grown, 0, 0, outH * rowBytes)
      out = grown
      capacity = grown.length / rowBytes
    }

    curr.data.copy(out, outH * rowBytes, appendY * rowBytes, (appendY + appendRows) * rowBytes)
    outH += appendRows
  }

  // 再清一次画布中偶发的全黑细线（1~3px）
  outH = removeInternalBlackBands(out, width, outH)

  const img = new Jimp({
    width,
    height: outH,
    data: out.subarray(0, outH * rowBytes)
  })
  return img.getBuffer('image/png')
}

/** 去掉内部很短的全黑带（典型 contentProtection / 叠层伪影） */
function removeInternalBlackBands(data: Buffer, width: number, height: number): number {
  const { x0, x1 } = contentXRange(width)
  const rowBytes = width * 4
  const keep: number[] = []
  let y = 0
  while (y < height) {
    if (rowLuma(data, width, y, x0, x1) >= 22) {
      keep.push(y)
      y++
      continue
    }
    // 连续黑行
    let y2 = y + 1
    while (y2 < height && rowLuma(data, width, y2, x0, x1) < 22) y2++
    const run = y2 - y
    // 只删短黑带；大块黑可能是真实 UI，保留
    if (run > 12) {
      for (let i = y; i < y2; i++) keep.push(i)
    }
    y = y2
  }
  if (keep.length === height) return height
  const out = Buffer.alloc(keep.length * rowBytes)
  for (let i = 0; i < keep.length; i++) {
    data.copy(out, i * rowBytes, keep[i]! * rowBytes, (keep[i]! + 1) * rowBytes)
  }
  out.copy(data, 0, 0, out.length)
  return keep.length
}

export type ManualScrollCallbacks = {
  onFrameCount?: (count: number) => void
  onStatus?: (text: string) => void
  /** 截屏前/后钩子：用于临时隐藏浮条，避免进画/变黑块 */
  onBeforeCapture?: () => void
  onAfterCapture?: () => void
}

function capture(rect: Rect, cb: ManualScrollCallbacks): Frame {
  try {
    cb.onBeforeCapture?.()
    return captureRegionFast(rect)
  } finally {
    cb.onAfterCapture?.()
  }
}

/**
 * 连续长截图：滚动时采样，按「画布底端对齐」拼成一张。
 * 不要求匀速。
 */
export class ManualScrollSession {
  private frames: Frame[] = []
  private running = false
  private rect: Rect
  private callbacks: ManualScrollCallbacks
  private loopPromise: Promise<void> | null = null

  constructor(rect: Rect, callbacks: ManualScrollCallbacks = {}) {
    this.rect = rect
    this.callbacks = callbacks
  }

  get frameCount(): number {
    return this.frames.length
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.frames = []

    const first = capture(this.rect, this.callbacks)
    this.frames.push(first)
    this.callbacks.onFrameCount?.(this.frames.length)
    this.callbacks.onStatus?.('长截图中，随意向下滚动即可')

    this.loopPromise = this.pollLoop()
  }

  async stop(): Promise<Buffer> {
    this.running = false
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
    try {
      const lastShot = capture(this.rect, this.callbacks)
      const prev = this.frames[this.frames.length - 1]!
      const m = framesScrollDelta(prev, lastShot)
      if (m && m.delta >= Math.max(6, Math.floor(prev.height * 0.015))) {
        this.frames.push(lastShot)
        this.callbacks.onFrameCount?.(this.frames.length)
      }
    } catch {
      // ignore
    }
    if (this.frames.length === 0) throw new Error('长截图失败：没有捕获到内容')
    this.callbacks.onStatus?.('正在拼接成长图…')
    return stitchFrames(this.frames)
  }

  cancel(): void {
    this.running = false
    this.frames = []
  }

  private async pollLoop(): Promise<void> {
    let last = this.frames[0]!
    const minDelta = Math.max(8, Math.floor(last.height * 0.025))
    const maxFrames = 220

    while (this.running) {
      await sleep(50)
      if (!this.running) break
      if (this.frames.length >= maxFrames) {
        this.callbacks.onStatus?.('已达最大长度，请点完成')
        break
      }

      let curr: Frame
      try {
        curr = capture(this.rect, this.callbacks)
      } catch {
        continue
      }

      const match = framesScrollDelta(last, curr)
      if (!match || match.delta < minDelta) continue
      if (match.score > 14) continue

      this.frames.push(curr)
      last = curr
      this.callbacks.onFrameCount?.(this.frames.length)
    }
  }
}
