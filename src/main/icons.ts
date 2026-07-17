import { app, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export function resourcePath(...parts: string[]): string {
  const name = join(...parts)
  const candidates = [
    join(process.cwd(), 'resources', name),
    join(__dirname, '../../resources', name),
    join(app.getAppPath(), 'resources', name)
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

export function appIconPath(): string {
  const ico = resourcePath('icon.ico')
  if (existsSync(ico)) return ico
  return resourcePath('icon.png')
}

export function loadAppIcon(): Electron.NativeImage {
  const image = nativeImage.createFromPath(appIconPath())
  return image
}

export function loadTrayIcon(): Electron.NativeImage {
  const ico = resourcePath('icon.ico')
  let image = existsSync(ico)
    ? nativeImage.createFromPath(ico)
    : nativeImage.createFromPath(resourcePath('tray.png'))
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(resourcePath('icon.png'))
  }
  if (process.platform === 'win32' && !image.isEmpty()) {
    return image.resize({ width: 16, height: 16 })
  }
  return image
}
