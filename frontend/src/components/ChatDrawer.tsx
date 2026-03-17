import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Send, Bot, Loader2, StopCircle, User, Wrench } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getSession, sendChatMessage, getAccessToken } from '../lib/api'

interface ChatMessage {
  role: string
  content: string
  timestamp: string | null
}

interface ToolStatus {
  name: string
  done: boolean
}

interface Props {
  agentId: string
  agentName: string
  agentEmoji?: string
  sessionKey?: string
  onClose: () => void
}

export default function ChatDrawer({ agentId, agentName, agentEmoji, sessionKey: sessionKeyProp, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // WebSocket refs
  const wsRef = useRef<WebSocket | null>(null)
  const wsReadyRef = useRef(false)
  const wsCompletedRef = useRef(false)
  const wsFinalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sessionKey = sessionKeyProp || `web-${agentId}`

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Load chat history
  const loadHistory = useCallback(async () => {
    try {
      const detail = await getSession(sessionKey)
      setMessages(detail.messages || [])
    } catch {
      setMessages([])
    }
  }, [sessionKey])

  // Initial load
  useEffect(() => {
    setLoading(true)
    loadHistory().finally(() => setLoading(false))
  }, [loadHistory])

  // Scroll on new messages
  useEffect(() => {
    scrollToBottom()
  }, [messages, toolStatuses, scrollToBottom])

  // Focus input
  useEffect(() => {
    if (!loading) inputRef.current?.focus()
  }, [loading])

  // WebSocket connection
  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const token = getAccessToken()
    if (!token) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const ws = new WebSocket(`${protocol}//${host}/api/openclaw/ws?token=${token}`)
    wsRef.current = ws
    wsReadyRef.current = false

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)

        // Gateway handshake
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          ws.send(JSON.stringify({
            type: 'req', id: 'c1', method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'drawer-client', mode: 'backend', displayName: 'chatdrawer', version: '1.0', platform: 'web' },
              role: 'operator', scopes: [],
            },
          }))
          return
        }

        if (msg.type === 'res' && msg.id === 'c1') {
          wsReadyRef.current = msg.ok === true
          return
        }

        // Tool use events
        if (msg.type === 'event' && msg.payload) {
          if (msg.event === 'tool.use.start') {
            const toolName = msg.payload.tool || msg.payload.name || 'tool'
            setToolStatuses(prev => [...prev.filter(t => t.name !== toolName), { name: toolName, done: false }])
          } else if (msg.event === 'tool.use.end') {
            const toolName = msg.payload.tool || msg.payload.name || 'tool'
            setToolStatuses(prev => prev.map(t => t.name === toolName ? { ...t, done: true } : t))
            // Remove completed tool statuses after a short delay
            setTimeout(() => {
              setToolStatuses(prev => prev.filter(t => !(t.name === toolName && t.done)))
            }, 2000)
          }
        }

        // Chat completion event
        if (msg.type === 'event' && msg.event === 'chat' && msg.payload) {
          const { state, sessionKey: evtKey } = msg.payload
          if ((state === 'final' || state === 'error' || state === 'aborted') &&
              (evtKey === sessionKey || evtKey?.replace(/:/g, '') === sessionKey.replace(/:/g, ''))) {

            getSession(sessionKey).then(detail => {
              setMessages(detail.messages || [])
              setToolStatuses([])
            }).catch(() => {})

            if (wsFinalTimerRef.current) clearTimeout(wsFinalTimerRef.current)
            wsFinalTimerRef.current = setTimeout(() => {
              wsCompletedRef.current = true
            }, 500)
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      wsReadyRef.current = false
      setTimeout(connectWs, 3000)
    }

    ws.onerror = () => { /* onclose fires after */ }
  }, [sessionKey])

  useEffect(() => {
    connectWs()
    return () => {
      if (wsFinalTimerRef.current) clearTimeout(wsFinalTimerRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const waitForResponse = async () => {
    wsCompletedRef.current = false
    const wsAvailable = wsRef.current?.readyState === WebSocket.OPEN && wsReadyRef.current

    if (wsAvailable) {
      const maxWait = 240000
      const start = Date.now()
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 300))
        if (wsCompletedRef.current) return
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) break
      }
      if (wsCompletedRef.current) return
    }

    // Fallback polling
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000))
      if (wsCompletedRef.current) return
      try {
        const detail = await getSession(sessionKey)
        const msgs = detail.messages || []
        setMessages(msgs)
        if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
          setSending(false)
          return
        }
      } catch { /* continue */ }
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    const userMsg: ChatMessage = { role: 'user', content: text, timestamp: new Date().toISOString() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setSending(true)
    setToolStatuses([])

    try {
      await sendChatMessage(sessionKey, text)
      await waitForResponse()
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `发送失败: ${(err as Error).message}`, timestamp: new Date().toISOString() },
      ])
    } finally {
      setSending(false)
      setToolStatuses([])
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 flex w-[440px] flex-col border-l border-border-default bg-bg-elevated shadow-floating"
      style={{ animation: 'slideInRight 0.2s ease-out' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-surface">
            {agentEmoji ? (
              <span className="text-base">{agentEmoji}</span>
            ) : (
              <Bot size={16} className="text-accent-blue" />
            )}
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">{agentName}</div>
            <div className="text-xs text-text-secondary">在线对话</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-text-secondary" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-text-secondary">
            <Bot size={40} className="mb-3 opacity-50" />
            <p className="text-sm">开始与 {agentName} 对话</p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                msg.role === 'user' ? 'bg-accent-blue' : 'bg-bg-surface'
              }`}>
                {msg.role === 'user' ? (
                  <User size={14} className="text-white" />
                ) : agentEmoji ? (
                  <span className="text-xs">{agentEmoji}</span>
                ) : (
                  <Bot size={14} className="text-accent-blue" />
                )}
              </div>
              <div
                className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-accent-blue text-white'
                    : 'bg-bg-surface text-text-primary border border-border-default'
                }`}
              >
                {msg.role === 'user' ? (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                ) : (
                  <div className="prose prose-sm max-w-none dark:prose-invert text-text-primary [&_pre]:bg-bg-base [&_pre]:rounded [&_pre]:p-2 [&_code]:text-accent-blue [&_code]:bg-bg-base [&_code]:rounded [&_code]:px-1 [&_a]:text-accent-blue">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {/* Tool call status rows */}
        {toolStatuses.map((t, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-surface">
              <Wrench size={14} className="text-accent-yellow" />
            </div>
            <div className="rounded-xl bg-bg-surface border border-border-default px-3.5 py-2 text-xs text-text-secondary flex items-center gap-2">
              {t.done ? (
                <span className="text-accent-green">✓</span>
              ) : (
                <Loader2 size={10} className="animate-spin text-accent-yellow" />
              )}
              <span>{t.done ? `已完成: ${t.name}` : `正在调用: ${t.name}...`}</span>
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {sending && toolStatuses.length === 0 && (
          <div className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-surface">
              {agentEmoji ? (
                <span className="text-xs">{agentEmoji}</span>
              ) : (
                <Bot size={14} className="text-accent-blue" />
              )}
            </div>
            <div className="rounded-xl bg-bg-surface border border-border-default px-3.5 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-text-secondary animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="h-1.5 w-1.5 rounded-full bg-text-secondary animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="h-1.5 w-1.5 rounded-full bg-text-secondary animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border-default px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送)"
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue placeholder:text-text-tertiary"
            style={{ maxHeight: '120px' }}
            disabled={sending}
          />
          <button
            onClick={sending ? undefined : handleSend}
            disabled={!input.trim() && !sending}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
              sending
                ? 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30'
                : input.trim()
                  ? 'bg-accent-blue text-white hover:bg-accent-blue/90'
                  : 'bg-bg-surface text-text-secondary'
            }`}
          >
            {sending ? <StopCircle size={18} /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}
