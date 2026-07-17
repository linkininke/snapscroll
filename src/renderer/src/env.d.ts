export {}

declare global {
  interface Window {
    snapscroll: {
      getHotkeys: () => Promise<{ capture: string; fullscreen: string }>
      openCaptureDir: () => Promise<string>
      startRegion: () => Promise<void>
      startScroll: () => Promise<void>
      onCaptureDone: (cb: (payload: { filePath: string; mode: string }) => void) => () => void
      onCaptureStatus: (cb: (payload: { status: string }) => void) => () => void
      onCaptureError: (cb: (payload: { message: string }) => void) => () => void
    }
    overlayApi: {
      cancel: () => Promise<void>
      confirm: (
        rect: { x: number; y: number; width: number; height: number },
        mode: 'region' | 'scroll'
      ) => Promise<void>
      windowAt: (point: { x: number; y: number }) => Promise<{
        x: number
        y: number
        width: number
        height: number
      } | null>
      onStart: (cb: (payload: {
        mode: 'region' | 'scroll'
        cursor?: { x: number; y: number }
      }) => void) => () => void
    }
    pinApi: {
      close: () => Promise<void>
      saveAs: (filePath: string) => Promise<string | null>
      copy: (filePath: string) => Promise<boolean>
    }
    scrollBarApi: {
      finish: () => Promise<void>
      cancel: () => Promise<void>
      onFrameCount: (cb: (count: number) => void) => () => void
    }
  }
}
