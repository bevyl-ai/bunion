import { render } from 'preact'
import { DashboardApp } from './components/DashboardApp'
import './styles.css'

const root = document.getElementById('root')
if (root) render(<DashboardApp />, root)
