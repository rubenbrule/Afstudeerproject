import { useState } from 'react'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import PrViewer from './components/PrViewer'
import PromptBeheer from './components/PromptBeheer'

export default function App() {
  const [currentPage, setCurrentPage] = useState('home')

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar onNavigate={setCurrentPage} currentPage={currentPage} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Header currentPage={currentPage} />

        <main style={{ padding: '20px', overflowY: 'auto' }}>
          {currentPage === 'home' && <PrViewer />}
          {currentPage === 'prompts' && <PromptBeheer />}
        </main>
      </div>
    </div>
  )
}