import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/contextmenu.css'
import './styles/toast.css'
import './styles/editor.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
)
