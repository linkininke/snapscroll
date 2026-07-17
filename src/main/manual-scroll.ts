import { Jimp } from 'jimp'
import type { Rect } from './scroll-stitch'
import { captureRegionFast, type RawFrame } from './capture-fast'

export type { Rect }

type Frame = RawFrame

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function frameSimilarity(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return 0
  const len = a.data.length
  let same = 0
  // 更快采样
  for (let i = 0; i < len; i += 128) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) {
      same++
    }
  }
  const total = Math.floor(len / 128)
  return total === 0 ? 0 : same / total
}

/** 估计相对上一帧向下滚了多少像素（基于条带匹配） */
function estimateScrollDelta(prev: Frame, next: Frame): number {
  const w = Math.min(prev.width, next.width)
  const band = Math.min(48, Math.floor(prev.height / 5))
  if (band < 8) return 0

  // 取 prev 底部 band 行，在 next 中从上往下搜索最佳匹配位置
  const maxShift = prev.height - band - 4
  let bestScore = Number.POSITIVE_INFINITY
  let bestY = 0
  const step = Math.max(1, Math.floor(maxShift / 60))

  for (let y = 0; y <= maxShift; y += step) {
    const score = bandDiff(prev, next, prev.height - band, y, band, w)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
    if (score < 4) break
  }

  // 细化
  for (let y = Math.max(0, bestY - step); y <= Math.min(maxShift, bestY + step); y++) {
    const score = bandDiff(prev, next, prev.height - band, y, band, w)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  if (bestScore > 40) return 0
  // prev 底部位于 next 的 bestY → 向下滚了 (prev.height - band - bestY) 附近
  // 更直观：新内容高度 ≈ next.height - (bestY + band) 不对
  // prev 底部 band 对齐 next[y..y+band]，说明滚动了 prev.height - band - y
  const delta = prev.height - band - bestY
  return Math.max(0, delta)
}

function bandDiff(
  prev: Frame,
  next: Frame,
  prevY0: number,
  nextY0: number,
  band: number,
  width: number
): number {
  const sampleX = Math.max(1, Math.floor(width / 80))
  const sampleY = Math.max(1, Math.floor(band / 16))
  let err = 0
  let count = 0
  for (let y = 0; y < band; y += sampleY) {
    for (let x = 0; x < width; x += sampleX) {
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

function findVerticalOverlap(prev: Frame, next: Frame, searchMin = 16): number {
  const w = Math.min(prev.width, next.width)
  const maxOverlap = Math.min(prev.height, next.height) - 4
  if (maxOverlap < searchMin) return 0

  let bestScore = Number.POSITIVE_INFINITY
  let bestOverlap = 0
  const step = Math.max(1, Math.floor(maxOverlap / 100))

  for (let overlap = maxOverlap; overlap >= searchMin; overlap -= step) {
    const score = stripDiff(prev, next, overlap, w)
    if (score < bestScore) {
      bestScore = score
      bestOverlap = overlap
    }
    if (score < 5) break
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

  if (bestScore > 50) return 0
  return bestOverlap
}

function stripDiff(prev: Frame, next: Frame, overlap: number, width: number): number {
  const sampleX = Math.max(1, Math.floor(width / 100))
  const sampleY = Math.max(1, Math.floor(overlap / 50))
  let err = 0
  let count = 0
  for (let y = 0; y < overlap; y += sampleY) {
    const prevY = prev.height - overlap + y
    for (let x = 0; x < width; x += sampleX) {
      const pi = (prevY * prev.width + x) * 4
      const ni = (y * next.width + x) * 4
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
    // 连续采样帧重叠通常很大；匹配失败时用保守默认
    overlaps.push(ov > 0 ? ov : Math.floor(frames[i].height * 0.7))
  }

  let totalHeight = frames[0].height
  for (let i = 1; i < frames.length; i++) {
    totalHeight += frames[i].height - overlaps[i]!
  }

  // 限制极端高度，防止内存爆掉（约 30000px）
  const maxH = 30000
  if (totalHeight > maxH) {
    throw new Error('长图过高，请缩短滚动范围后再试')
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
    if (skip > 0 && skip < frame.height) {
      src.crop({ x: 0, y: skip, w: frame.width, h: frame.height - skip })
    }
    out.composite(src, 0, cursorY)
    cursorY += src.height
  }

  return out.getBuffer('image/png')
}

export type ManualScrollCallbacks = {
  onFrameCount?: (count: number) => void
  onStatus?: (text: string) => void
}

/**
 * 连续长截图：滚动过程中高频截取，从开头滚到结束拼成一整张。
 * 不再“停稳才截一张”。
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

    const first = captureRegionFast(this.rect)
    this.frames.push(first)
    this.callbacks.onFrameCount?.(this.frames.length)
    this.callbacks.onStatus?.('连续截取中，请匀速向下滚动')

    this.loopPromise = this.pollLoop()
  }

  async stop(): Promise<Buffer> {
    this.running = false
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
    try {
      const last = captureRegionFast(this.rect)
      const prev = this.frames[this.frames.length - 1]
      if (!prev || frameSimilarity(prev, last) < 0.995) {
        this.frames.push(last)
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
    // 有可见推进就收帧；阈值尽量小，保证边滚边截是连续条带
    const minAdvance = Math.max(12, Math.floor(last.height * 0.05))
    const maxFrames = 240

    while (this.running) {
      // 高频连续采样（边滚边截，不等停稳）
      await sleep(40)
      if (!this.running) break
      if (this.frames.length >= maxFrames) {
        this.callbacks.onStatus?.('已达最大长度，请点完成')
        break
      }

      let curr: Frame
      try {
        curr = captureRegionFast(this.rect)
      } catch {
        continue
      }

      // 几乎没动：继续盯着滚，不丢弃会话
      const sim = frameSimilarity(curr, last)
      if (sim > 0.998) continue

      // 估算滚动量；只要画面在推进就立刻收帧
      const delta = estimateScrollDelta(last, curr)
      const advanced = delta >= minAdvance || sim < 0.97

      if (!advanced) continue

      this.frames.push(curr)
      last = curr
      this.callbacks.onFrameCount?.(this.frames.length)
    }
  }
}
