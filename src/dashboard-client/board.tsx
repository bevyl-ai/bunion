import { render } from 'preact'
import { DashboardApp } from './components/DashboardApp'

// Not a static <link> in board.html: Bun's HTML-import bundler tries to resolve every href it finds there as a
// local module, and /dashboard.css is a route served at runtime (see dashboard.ts's compileTailwindCss), not a
// file on disk it can bundle.
const link = document.createElement('link')
link.rel = 'stylesheet'
link.href = '/dashboard.css'
document.head.appendChild(link)

const root = document.getElementById('root')
if (root) render(<DashboardApp />, root)
