import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/space-grotesk'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Dashboard root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
