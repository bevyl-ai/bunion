import { render } from 'preact'
import { DashboardApp } from './components/DashboardApp'
import { startLiveClock } from './lib/liveClock'

// Not a static <link> in board.html: Bun's HTML-import bundler tries to resolve every href it finds there as a
// local module, and /dashboard.css is a route served at runtime (see dashboard.ts's compileTailwindCss), not a
// file on disk it can bundle.
const link = document.createElement('link')
link.rel = 'stylesheet'
link.href = '/dashboard.css'
document.head.appendChild(link)

const root = document.getElementById('root')
if (root) render(<DashboardApp />, root)

// One vanilla setInterval keeps every live time display fresh by patching the DOM directly — no React tick.
startLiveClock()
