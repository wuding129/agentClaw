import { createContext, useContext, useState, useCallback } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ChatDrawer from './ChatDrawer'

interface ChatTarget {
  agentId: string
  agentName: string
  agentEmoji?: string
}

interface ChatContextValue {
  openChat: (target: ChatTarget) => void
  closeChat: () => void
}

const ChatContext = createContext<ChatContextValue>({
  openChat: () => {},
  closeChat: () => {},
})

export function useChat() {
  return useContext(ChatContext)
}

export default function Layout() {
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const openChat = useCallback((target: ChatTarget) => {
    // Toggle if same agent
    setChatTarget(prev =>
      prev?.agentId === target.agentId ? null : target,
    )
  }, [])

  const closeChat = useCallback(() => {
    setChatTarget(null)
  }, [])

  return (
    <ChatContext.Provider value={{ openChat, closeChat }}>
      <div className="flex h-screen overflow-hidden bg-bg-base">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(v => !v)} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-6">
            <Outlet />
          </main>
        </div>
        {chatTarget && (
          <ChatDrawer
            agentId={chatTarget.agentId}
            agentName={chatTarget.agentName}
            agentEmoji={chatTarget.agentEmoji}
            onClose={closeChat}
          />
        )}
      </div>
    </ChatContext.Provider>
  )
}
