import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const LOG_DIR = 'E:\\截图文件'
const LOG_FILE = join(LOG_DIR, 'app-error.log')

export function crashLog(tag: string, err: unknown): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)
    const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n\n`
    appendFileSync(LOG_FILE, line, 'utf8')
    console.error(`[${tag}]`, err)
  } catch {
    // ignore logging failures
  }
}
