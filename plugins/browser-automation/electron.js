import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ENDPOINT_WAIT_MS = 10_000
const SCREEN_MAX_DIMENSION = 3200

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function readDevToolsPort(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort')
  try {
    const [portLine] = (await readFile(file, 'utf8')).split(/\r?\n/)
    const port = Number(portLine)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

async function getBrowserEndpoint(app) {
  if (!app.commandLine?.hasSwitch('remote-debugging-port')) {
    throw new Error('CDP 启动入口尚未生效。安装或启用插件后，请完全退出并重启 Artificer。')
  }
  const configuredPort = Number(app.commandLine.getSwitchValue('remote-debugging-port'))
  const deadline = Date.now() + ENDPOINT_WAIT_MS
  let lastError = null
  while (Date.now() < deadline) {
    const port = await readDevToolsPort(app.getPath('userData')) ||
      (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : null)
    if (port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(1200)
        })
        if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`)
        const info = await response.json()
        const ws = new URL(info.webSocketDebuggerUrl)
        if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || Number(ws.port) !== port) {
          throw new Error('CDP WebSocket 地址不在本机回环接口上。')
        }
        return { browserURL: `http://127.0.0.1:${port}` }
      } catch (error) {
        lastError = error
      }
    }
    await wait(150)
  }
  if (lastError) throw new Error(`无法连接 Artificer 的本机 CDP：${lastError.message}`)
  throw new Error('CDP 尚未启用。安装或启用插件后，请完全退出并重启 Artificer。')
}

function dimensionsFor(display, maxDimension = SCREEN_MAX_DIMENSION) {
  const scale = Number(display.scaleFactor) || 1
  const width = Math.max(1, Math.round(display.bounds.width * scale))
  const height = Math.max(1, Math.round(display.bounds.height * scale))
  const ratio = Math.min(1, maxDimension / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

async function listScreens({ screen, desktopCapturer }) {
  const displays = screen.getAllDisplays()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  })
  const primaryId = String(screen.getPrimaryDisplay().id)
  return displays.map((display, index) => {
    const source = sources.find(item => item.display_id && item.display_id === String(display.id)) || sources[index]
    return {
      displayId: String(display.id),
      name: source?.name || `屏幕 ${index + 1}`,
      width: Math.round(display.bounds.width * (Number(display.scaleFactor) || 1)),
      height: Math.round(display.bounds.height * (Number(display.scaleFactor) || 1)),
      primary: String(display.id) === primaryId
    }
  })
}

async function captureDesktop({ screen, desktopCapturer }, args = {}) {
  const displays = screen.getAllDisplays()
  if (!displays.length) throw new Error('系统没有可用的显示器。')
  const primaryId = String(screen.getPrimaryDisplay().id)
  const display = args.displayId
    ? displays.find(item => String(item.id) === String(args.displayId))
    : displays.find(item => String(item.id) === primaryId) || displays[0]
  if (!display) throw new Error(`找不到显示器：${args.displayId}`)

  const size = dimensionsFor(display)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const displayIndex = displays.indexOf(display)
  const source = sources.find(item => item.display_id && item.display_id === String(display.id)) || sources[displayIndex] || sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('系统没有返回可用的桌面截图。')

  let image = source.thumbnail
  const actualSize = image.getSize()
  const maxEdge = Math.max(actualSize.width, actualSize.height)
  if (maxEdge > SCREEN_MAX_DIMENSION) {
    const ratio = SCREEN_MAX_DIMENSION / maxEdge
    image = image.resize({
      width: Math.max(1, Math.round(actualSize.width * ratio)),
      height: Math.max(1, Math.round(actualSize.height * ratio)),
      quality: 'best'
    })
  }

  const outputSize = image.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${image.toJPEG(86).toString('base64')}`,
    width: outputSize.width,
    height: outputSize.height,
    mode: 'screen',
    scope: 'desktop',
    title: source.name || '整个桌面',
    displayId: String(display.id)
  }
}

export function register(ctx) {
  const electron = ctx.electron
  ctx.rpc.handle('browserAutomation.cdpEndpoint', () => getBrowserEndpoint(electron.app))
  ctx.rpc.handle('browserAutomation.listScreens', () => listScreens(electron))
  ctx.rpc.handle('browserAutomation.captureDesktop', args => captureDesktop(electron, args))
  ctx.logger.info('Browser automation Electron bridge registered')
}

export { captureDesktop, dimensionsFor, getBrowserEndpoint, listScreens }
