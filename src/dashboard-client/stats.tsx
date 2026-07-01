import { render } from 'preact'
import { StatsApp } from './components/StatsApp'
import './stats-styles.css'

const root = document.getElementById('root')
if (root) render(<StatsApp />, root)
