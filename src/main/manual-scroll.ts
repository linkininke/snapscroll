import { captureRegionRaw } from './capture'
import { Jimp } from 'jimp'
import type { Rect } from './scroll-stitch'

export type { Rect }

type Frame = {
  data: Buffer
  width: number
  height: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function frameSimilarity(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return 0
  const len = a.data.length
  let same = 0
  for (let i = 0; i < len; i += 64) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) {
      same++
    }
  }
  const total = Math.floor(len / 64)
  return total === 0 ? 0 : same / total
}

function findVerticalOverlap(prev: Frame, next: Frame, searchMin = 24): number {
  const w = Math.min(prev.width, next.width)
  const maxOverlap = Math.min(prev.height, next.height) - 8
  if (maxOverlap < searchMin) return 0

  let bestScore = Number.POSITIVE_INFINITY
  let bestOverlap = 0
  const step = Math.max(1, Math.floor(maxOverlap / 80))

  for (let overlap = maxOverlap; overlap >= searchMin; overlap -= step) {
    const score = stripDiff(prev, next, overlap, w)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
    if (score < 6) break
  }

  const refineFrom = Math.max(searchMin, bestOverlap - step * 2)
  const refineTo = Math.min(maxOverlap, bestOverlap + step * 2)
  for (let overlap = refineFrom; overlap <= refineTo; overlap++) {
    const score = stripDiff(prev, next, overlap, w)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
  }

  if (bestScore > 45) return 0
  return bestOverlap
}

function stripDiff(prev: Frame, next: Frame, overlap: number, width: number): number {
  const sampleX = Math.max(1, Math.floor(width / 120))
  const sampleY = Math.max(1, Math.floor(overlap / 40))
  let err = 0
  let count = 0

  for (let y = 0; y < overlap; y += sampleY) {
    const prevY = prev.height - overlap + y
    const nextY = y
    for (let x = 0; x < width; x += sampleX) {
      const pi = (prevY * prev.width + x) * 4
      const ni = (nextY * next.width + x) * 4
      err +=
        Math.abs(prev.data[pi]! - next.data[ni]!) +
        Math.abs(prev.data[pi + 1]! - next.data[ni + 1]!) +
        Math.abs(prev.data[pi + 2]! - next.data[ni + 2]!)
      count++
    }
  }
  return count === 0 ? 999 : err / count
}

export async function stitchFrames(frames: Frame[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error('没有捕获到画面')
  if (frames.length === 1) {
    const img = new Jimp({
      width: frames[0].width,
      height: frames[0].height,
      data: frames[0].data
    })
    return img.getBuffer('image/png')
  }

  const overlaps: number[] = [0]
  for (let i = 1; i < frames.length; i++) {
    const ov = findVerticalOverlap(frames[i - 1], frames[i])
    overlaps.push(ov > 0 ? ov : Math.floor(frames[i].height * 0.45))
  }

  let totalHeight = frames[0].height
  for (let i = 1; i < frames.length; i++) {
    totalHeight += frames[i].height - overlaps[i]!
  }

  const width = frames[0].width
  const out = new Jimp({ width, height: totalHeight, color: 0xffffffff })
  let cursorY = 0

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!
    const skip = i === 0 ? 0 : overlaps[i]!
    const src = new Jimp({
      width: frame.width,
      height: frame.height,
      data: Buffer.from(frame.data)
    })
    if (skip > 0) {
      src.crop({ x: 0, y: skip, w: frame.width, h: frame.height - skip })
    }
    out.composite(src, 0, cursorY)
    cursorY += src.height
  }

  return out.getBuffer('image/png')
}

async function grab(rect: Rect): Promise<Frame> {
  const raw = await captureRegionRaw(rect)
  return { data: raw.bitmap, width: raw.width, height: raw.height }
}

export type ManualScrollCallbacks = {
  onFrameCount?: (count: number) => void
}

/**
 * 手动滚动长截图：用户自己滚页面，停稳后自动截取新帧；调用 stop() 结束拼接。
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

    const first = await grab(this.rect)
    this.frames.push(first)
    this.callbacks.onFrameCount?.(this.frames.length)

    this.loopPromise = this.pollLoop()
  }

  async stop(): Promise<Buffer> {
    this.running = false
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
    // 结束前再抓一帧，避免漏掉最后一屏
    try {
      const last = await grab(this.rect)
      const prev = this.frames[this.frames.length - 1]
      if (!prev || frameSimilarity(prev, last) < 0.985) {
        this.frames.push(last)
        this.callbacks.onFrameCount?.(this.frames.length)
      }
    } catch {
      // ignore
    }
    return stitchFrames(this.frames)
  }

  cancel(): void {
    this.running = false
    this.frames = []
  }

  private async pollLoop(): Promise<void> {
    let last = this.frames[0]!

    while (this.running) {
      await sleep(120)
      if (!this.running) break

      let curr: Frame
      try {
        curr = await grab(this.rect)
      } catch {
        continue
      }

      // 画面几乎没变：用户还在看/还没滚
      if (frameSimilarity(curr, last) > 0.985) continue

      // 正在滚动：等到画面稳定再截
      let stable = 0
      let candidate = curr
      while (this.running && stable < 2) {
        await sleep(100)
        let next: Frame
        try {
          next = await grab(this.rect)
        } catch {
          break
        }
        if (frameSimilarity(next, candidate) > 0.99) {
          stable++
        } else {
          candidate = next
          stable = 0
        }
      }

      if (!this.running) break

      if (frameSimilarity(candidate, last) < 0.985) {
        this.frames.push(candidate)
        last = candidate
        this.callbacks.onFrameCount?.(this.frames.length)
      }
    }
  }
}
