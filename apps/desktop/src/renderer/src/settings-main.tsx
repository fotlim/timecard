import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsWindow } from './SettingsWindow'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/settings.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root')

createRoot(el).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>
)
