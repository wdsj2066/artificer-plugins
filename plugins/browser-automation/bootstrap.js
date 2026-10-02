/**
 * Enables the host Chromium's CDP endpoint before Electron becomes ready.
 * The random port is written by Chromium to DevToolsActivePort in userData.
 */
export function register(ctx) {
  const { app } = ctx.electron
  if (!app || app.isReady()) throw new Error('浏览器自动化 CDP 必须在 Electron app.ready 前启用。')

  if (!app.commandLine.hasSwitch('remote-debugging-address')) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  }
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-port', '0')
  }

  ctx.logger.info('Browser automation CDP bootstrap enabled; restart Artificer after installing or enabling this plugin.')
}
