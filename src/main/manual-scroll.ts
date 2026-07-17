import { Jimp } from 'jimp'
import type { Rect } from './scroll-stitch'
import { captureRegionFast, type RawFrame } from './capture-fast'

export type { Rect }

type Frame = RawFrame

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function contentXRange(width: number): { x0: number; x1: number } {
  const x0 = Math.min(Math.floor(width * 0.1), 64)
  const x1 = Math.max(x0 + 48, width - Math.min(Math.floor(width * 0.06), 24))
  return { x0, x1 }
}

function frameSimilarity(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return 0
  const { x0, x1 } = contentXRange(a.width)
  const stepY = Math.max(1, Math.floor(a.height / 40))
  const stepX = Math.max(1, Math.floor((x1 - x0) / 40))
  let same = 0
  let total = 0
  for (let y = 0; y < a.height; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * a.width + x) * 4
      total++
      if (
        Math.abs(a.data[i]! - b.data[i]!) +
          Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
          Math.abs(a.data[i + 2]! - b.data[i + 2]!) <
        18
      ) {
        same++
      }
    }
  }
  return total === 0 ? 0 : same / total
}

function stripDiff(
  prev: Frame,
  next: Frame,
  prevY0: number,
  nextY0: number,
  band: number,
  x0: number,
  x1: number
): number {
  const sampleX = Math.max(1, Math.floor((x1 - x0) / 50))
  const sampleY = Math.max(1, Math.floor(band / 12))
  let err = 0
  let count = 0
  for (let y = 0; y < band; y += sampleY) {
    for (let x = x0; x < x1; x += sampleX) {
      const pi = ((prevY0 + y) * prev.width + x) * 4
      const ni = ((nextY0 + y) * next.width + x) * 4
      err +=
        Math.abs(prev.data[pi]! - next.data[ni]!) +
        Math.abs(prev.data[pi + 1]! - next.data[ni + 1]!) +
        Math.abs(prev.data[pi + 2]! - next.data[ni + 2]!)
      count++
    }
  }
  return count === 0 ? 999 : err / count
}

/**
 * 找 prev 底部内容在 next 中的位置，返回应追加的新像素高度。
 * 兼容微信顶部固定标题栏。
 */
function findAppendHeight(prev: Frame, next: Frame): number | null {
  if (prev.width !== next.width || prev.height !== next.height) return null
  const h = prev.height
  const { x0, x1 } = contentXRange(prev.width)
  const band = Math.min(36, Math.max(20, Math.floor(h / 12)))
  const topGuard = Math.max(40, Math.floor(h * 0.12))
  const prevBandY = h - band - 4
  if (prevBandY <= topGuard) return null

  let bestScore = Number.POSITIVE_INFINITY
  let bestY = -1
  const coarse = Math.max(1, Math.floor((prevBandY - topGuard) / 90))

  for (let y = topGuard; y <= prevBandY; y += coarse) {
    const score = stripDiff(prev, next, prevBandY, y, band, x0, x1)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
    if (score < 3) break
  }
  if (bestY < 0) return null

  for (let y = Math.max(topGuard, bestY - coarse); y <= Math.min(prevBandY, bestY + coarse); y++) {
    const score = stripDiff(prev, next, prevBandY, y, band, x0, x1)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  if (bestScore > 22) return null

  // prev 底部位于 next 的 bestY → 新内容高度 ≈ h - (bestY + band)
  const append = h - (bestY + band)
  if (append < 4) return null
  return append
}

/**
 * 画布底端对齐：把已拼结果的底带在新帧中定位，返回追加起点 y。
 */
function findCanvasAppendY(
  canvas: Buffer,
  canvasW: number,
  canvasH: number,
  frame: Frame
): { appendY: number; score: number } | null {
  const band = Math.min(36, Math.max(20, Math.floor(frame.height / 12)))
  if (canvasH < band + 8) return null
  const { x0, x1 } = contentXRange(canvasW)
  const tipY = canvasH - band
  const topGuard = Math.max(36, Math.floor(frame.height * 0.1))
  const yMax = frame.height - band

  let bestScore = Number.POSITIVE_INFINITY
  let bestY = -1
  const coarse = Math.max(1, Math.floor((yMax - topGuard) / 100))

  for (let y = topGuard; y <= yMax; y += coarse) {
    const score = stripDiff(
      { data: canvas, width: canvasW, height: canvasH },
      frame,
      tipY,
      y,
      band,
      x0,
      x1
    )
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
    if (score < 2.5) break
  }
  if (bestY < 0 || bestScore > 20) return null

  for (let y = Math.max(topGuard, bestY - coarse); y <= Math.min(yMax, bestY + coarse); y++) {
    const score = stripDiff(
      { data: canvas, width: canvasW, height: canvasH },
      frame,
      tipY,
      y,
      band,
      x0,
      x1
    )
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  const appendY = bestY + band
  if (appendY >= frame.height - 3) return null
  return { appendY, score: bestScore }
}

export async function stitchFrames(frames: Frame[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error('没有捕获到画面')
  if (frames.length === 1) {
    const img = new Jimp({
      width: frames[0].width,
      height: frames[0].height,
      data: Buffer.from(frames[0].data)
    })
    return img.getBuffer('image/png')
  }

  const first = frames[0]!
  const width = first.width
  const rowBytes = width * 4
  const maxH = 30000

  let capacity = Math.min(
    maxH,
    frames.reduce((s, f) => s + f.height, 0)
  )
  let out = Buffer.alloc(capacity * rowBytes)
  first.data.copy(out, 0, 0, first.height * rowBytes)
  let outH = first.height
  let last = first
  let appended = 0

  for (let i = 1; i < frames.length; i++) {
    const curr = frames[i]!
    if (curr.width !== width) continue

    let appendY = -1
    const tip = findCanvasAppendY(out, width, outH, curr)
    if (tip) {
      appendY = tip.appendY
    } else {
      const h = findAppendHeight(last, curr)
      if (h != null) appendY = curr.height - h
    }
    if (appendY < 0 || appendY >= curr.height - 3) continue

    const rows = curr.height - appendY
    if (rows < 4) continue

    if (outH + rows > maxH) throw new Error('长图过高，请缩短滚动范围后再试')
    if (outH + rows > capacity) {
      const grown = Buffer.alloc(Math.min(maxH, Math.max(outH + rows, capacity * 2)) * rowBytes)
      out.copy(grown, 0, 0, outH * rowBytes)
      out = grown
      capacity = grown.length / rowBytes
    }

    curr.data.copy(out, outH * rowBytes, appendY * rowBytes, curr.height * rowBytes)
    outH += rows
    last = curr
    appended++
  }

  if (appended === 0) {
    console.warn('[scroll] no frames appended — returning first frame only. kept=', frames.length)
  }

  const img = new Jimp({
    width,
    height: outH,
    data: out.subarray(0, outH * rowBytes)
  })
  return img.getBuffer('image/png')
}

export type ManualScrollCallbacks = {
  onFrameCount?: (count: number) => void
  onStatus?: (text: string) => void
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
 * 连续长截图：滚动时持续收帧，结束后拼成一张长图。
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
    this.callbacks.onStatus?.('长截图中，请滚动窗口，完成后点按钮或按 F1')

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
      const prev = this.frames[this.frames.length - 1]
      if (!prev || frameSimilarity(prev, lastShot) < 0.995) {
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
    const maxFrames = 250

    while (this.running) {
      await sleep(55)
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

      // 画面有变化就收帧（不要求匀速、不要求滚很大）
      if (frameSimilarity(last, curr) > 0.994) continue

      this.frames.push(curr)
      last = curr
      this.callbacks.onFrameCount?.(this.frames.length)
    }
  }
}
