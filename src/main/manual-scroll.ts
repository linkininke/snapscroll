import { Jimp } from 'jimp'
import type { Rect } from './scroll-stitch'
import { captureRegionFast, type RawFrame } from './capture-fast'

export type { Rect }

type Frame = RawFrame

type ScrollMatch = {
  /** 相对上一帧向下滚了多少像素 */
  delta: number
  /** 条带平均色差，越小越可信 */
  score: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bandDiffAt(
  a: Frame,
  b: Frame,
  aY: number,
  bY: number,
  band: number,
  width: number
): number {
  const sampleX = Math.max(1, Math.floor(width / 64))
  const sampleY = Math.max(1, Math.floor(band / 12))
  let err = 0
  let count = 0
  for (let y = 0; y < band; y += sampleY) {
    for (let x = 0; x < width; x += sampleX) {
      const ai = ((aY + y) * a.width + x) * 4
      const bi = ((bY + y) * b.width + x) * 4
      err +=
        Math.abs(a.data[ai]! - b.data[bi]!) +
        Math.abs(a.data[ai + 1]! - b.data[bi + 1]!) +
        Math.abs(a.data[ai + 2]! - b.data[bi + 2]!)
      count++
    }
  }
  return count === 0 ? 999 : err / count
}

/**
 * 估计 prev→next 向下滚了多少像素。
 * 用画面中下部条带做模板（避开微信顶部固定标题栏），不依赖滚动是否匀速。
 */
function estimateScrollMatch(prev: Frame, next: Frame): ScrollMatch | null {
  if (prev.width !== next.width || prev.height !== next.height) return null

  const h = prev.height
  const w = prev.width
  const topGuard = Math.max(48, Math.floor(h * 0.14))
  const bottomGuard = Math.max(6, Math.floor(h * 0.03))
  const band = Math.min(28, Math.max(16, Math.floor(h / 10)))
  if (h < topGuard + bottomGuard + band + 30) return null

  // 模板取自上一帧偏下位置（已滚出顶部 chrome）
  const prevBandY = h - bottomGuard - band
  const searchMin = topGuard
  const searchMax = prevBandY
  if (searchMax <= searchMin) return null

  let bestScore = Number.POSITIVE_INFINITY
  let bestY = prevBandY
  const coarse = Math.max(1, Math.floor((searchMax - searchMin) / 80))

  for (let y = searchMin; y <= searchMax; y += coarse) {
    const score = bandDiffAt(prev, next, prevBandY, y, band, w)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
    if (score < 3) break
  }

  const refineFrom = Math.max(searchMin, bestY - coarse)
  const refineTo = Math.min(searchMax, bestY + coarse)
  for (let y = refineFrom; y <= refineTo; y++) {
    const score = bandDiffAt(prev, next, prevBandY, y, band, w)
    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  // 第二道校验：再取一条更高的条带，delta 应一致
  const prevBandY2 = Math.max(topGuard, prevBandY - Math.floor(h * 0.22))
  const expectY2 = bestY - (prevBandY - prevBandY2)
  let score2 = 999
  if (expectY2 >= searchMin && expectY2 + band <= h) {
    score2 = bandDiffAt(prev, next, prevBandY2, expectY2, band, w)
  }

  const delta = prevBandY - bestY
  if (delta < 1) return null

  // 白底聊天窗容易假匹配：分数必须够低，且第二道不能差太多
  if (bestScore > 18) return null
  if (score2 < 900 && score2 > bestScore + 14) return null

  return { delta, score: bestScore }
}

function copyRows(src: Frame, y0: number, rows: number): Buffer {
  const start = Math.max(0, y0) * src.width * 4
  const end = Math.min(src.height, y0 + rows) * src.width * 4
  return Buffer.from(src.data.subarray(start, end))
}

/**
 * 按滚动位移拼接：只追加「新滚出来」的底部像素，避免碎条重复。
 * 不要求匀速；慢/快都可以，匹配不上的帧直接丢弃。
 */
export async function stitchFrames(frames: Frame[]): Promise<Buffer> {
  if (frames.length === 0) throw new Error('没有捕获到画面')

  const first = frames[0]!
  const width = first.width
  const height = first.height
  const rowBytes = width * 4

  // 预估容量：首帧 + 后续最大可能新增
  let capacity = height
  for (let i = 1; i < frames.length; i++) {
    capacity += frames[i]!.height
  }
  const maxH = 30000
  capacity = Math.min(capacity, maxH)

  let out = Buffer.alloc(capacity * rowBytes)
  first.data.copy(out, 0, 0, height * rowBytes)
  let outH = height
  let last = first
  let used = 1

  const minDelta = Math.max(8, Math.floor(height * 0.02))

  for (let i = 1; i < frames.length; i++) {
    const curr = frames[i]!
    const match = estimateScrollMatch(last, curr)
    if (!match || match.delta < minDelta) continue

    // 快滚时 delta 可能很大；慢滚则很小。只贴底部新增行。
    let delta = Math.min(match.delta, height - 1)
    // 匹配很差时宁可不贴，也不要贴错
    if (match.score > 14 && delta < Math.floor(height * 0.08)) continue

    if (outH + delta > maxH) {
      throw new Error('长图过高，请缩短滚动范围后再试')
    }
    if (outH + delta > capacity) {
      const grown = Buffer.alloc(Math.min(maxH, capacity * 2) * rowBytes)
      out.copy(grown, 0, 0, outH * rowBytes)
      out = grown
      capacity = grown.length / rowBytes
    }

    const chunk = copyRows(curr, height - delta, delta)
    chunk.copy(out, outH * rowBytes)
    outH += delta
    last = curr
    used++
  }

  if (used === 1 && frames.length > 1) {
    // 全程匹配失败：至少返回首帧，避免碎图
    console.warn('[scroll] stitch fallback: only first frame matched')
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
}

/**
 * 连续长截图：滚动时高频采样，按位移拼成一张。
 * 不要求匀速；停稳也不必，滚完点完成即可。
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
      const lastShot = captureRegionFast(this.rect)
      const prev = this.frames[this.frames.length - 1]!
      const m = estimateScrollMatch(prev, lastShot)
      if (m && m.delta >= Math.max(8, Math.floor(prev.height * 0.02))) {
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
    const minDelta = Math.max(10, Math.floor(last.height * 0.03))
    const maxFrames = 200

    while (this.running) {
      await sleep(45)
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

      const match = estimateScrollMatch(last, curr)
      // 只在「确认滚出了一截新内容」时收帧；慢滚多等几拍，快滚一次收很大 delta
      if (!match || match.delta < minDelta) continue
      if (match.score > 16) continue

      this.frames.push(curr)
      last = curr
      this.callbacks.onFrameCount?.(this.frames.length)
    }
  }
}
