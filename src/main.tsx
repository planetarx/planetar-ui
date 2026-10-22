import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startFleetListener } from '@/lib/fleetListener'
import { startVesselSeed } from '@/lib/vesselSeed'

startFleetListener()
startVesselSeed()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
