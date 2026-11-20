import SessionSearch from './views/App.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({
    id: 'session-search.route',
    name: 'session-search',
    path: '/plugin/session-search',
    target: 'app.view',
    component: SessionSearch,
    props: { artificer: ctx.artificer }
  })
}

