import { Routes, Route } from 'react-router-dom'
import AppLayout from './components/AppLayout.jsx'
import Dashboard from './components/Dashboard.jsx'
import CollectionDetail from './components/CollectionDetail.jsx'
import GameBrowser from './components/GameBrowser.jsx'
import GameDetail from './components/GameDetail.jsx'
import DownloadManager from './components/DownloadManager.jsx'
import OperationsPage from './components/OperationsPage.jsx'
import CollectionForm from './components/CollectionForm.jsx'
import GameSetForm from './components/GameSetForm.jsx'
import Settings from './components/Settings.jsx'
import { useUI } from './contexts/UIContext.jsx'

function Modals() {
  const { showCollectionForm, showGameSetForm, showSettings } = useUI()
  return (
    <>
      {showCollectionForm && <CollectionForm />}
      {showGameSetForm && <GameSetForm />}
      {showSettings && <Settings />}
    </>
  )
}

export default function App() {
  return (
    <>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="collections/:id" element={<GameBrowser />} />
          <Route path="collections/:id/settings" element={<CollectionDetail />} />
          <Route path="collections/:id/browse" element={<GameBrowser />} />
          <Route path="collections/:id/browse/game/:gameId" element={<GameDetail />} />
          <Route path="collections/:id/game/:gameId" element={<GameDetail />} />
          <Route path="game-sets/:id" element={<GameBrowser />} />
          <Route path="game-sets/:id/game/:gameId" element={<GameDetail />} />
          <Route path="browse" element={<GameBrowser />} />
          <Route path="downloads" element={<DownloadManager />} />
          <Route path="operations" element={<OperationsPage />} />
        </Route>
      </Routes>
      <Modals />
    </>
  )
}
