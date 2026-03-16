import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Plus, Search, Loader2, Shield, User } from 'lucide-react'
import { fetchAgents, removeAgent } from '../store/agents'
import { getMe } from '../lib/api'
import type { BackendAgent } from '../types/agent'
import type { AuthUser } from '../lib/api'

// System agents that cannot be deleted
const SYSTEM_AGENTS = ['main', 'skill-reviewer']

export default function Agents() {
  const navigate = useNavigate()
  const [agents, setAgents] = useState<BackendAgent[]>([])
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    Promise.all([fetchAgents(), getMe().catch(() => null)])
      .then(([agentsData, userData]) => {
        setAgents(agentsData)
        setUser(userData)
      })
      .finally(() => setLoading(false))
  }, [])

  // Categorize agents
  const systemAgents = agents.filter(a => SYSTEM_AGENTS.includes(a.id))
  const myAgent = agents.find(a => a.id === user?.id)
  const otherAgents = agents.filter(a => !SYSTEM_AGENTS.includes(a.id) && a.id !== user?.id)

  // Filter function
  const filterAgents = (list: BackendAgent[]) => {
    if (!search.trim()) return list
    const term = search.toLowerCase()
    return list.filter(a => {
      const name = (a as any).displayName || a.name || a.identity?.name || a.id || ''
      return name.toLowerCase().includes(term) || (a.id || '').toLowerCase().includes(term)
    })
  }

  const handleDelete = async (e: React.MouseEvent, agent: BackendAgent) => {
    e.stopPropagation()
    if (confirm('确定删除该 Agent？')) {
      await removeAgent(agent.id)
      const refreshed = await fetchAgents()
      setAgents(refreshed)
    }
  }

  const AgentCard = ({ agent, showDelete = true }: { agent: BackendAgent; showDelete?: boolean }) => (
    <div
      key={agent.id}
      className="rounded-xl border border-border-default bg-bg-surface p-5 hover:border-accent-blue/30 transition-colors cursor-pointer shadow-card"
      onClick={() => navigate(`/agents/${agent.id}`)}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-base">
            {agent.identity?.emoji ? (
              <span className="text-lg">{agent.identity.emoji}</span>
            ) : (
              <Bot size={20} className="text-accent-blue" />
            )}
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">{(agent as any).displayName || agent.name || agent.identity?.name || agent.id}</div>
            <div className="text-xs text-text-secondary">{agent.id}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-3">
        {showDelete && (
          <button
            onClick={e => handleDelete(e, agent)}
            className="text-xs text-accent-red/70 hover:text-accent-red"
          >
            删除
          </button>
        )}
      </div>
    </div>
  )

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-text-secondary" size={32} /></div>

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Agents 管理</h1>
          <p className="mt-1 text-sm text-text-secondary">管理和配置 AI Agents</p>
        </div>
        <button
          onClick={() => navigate('/agents/create')}
          className="flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 transition-colors"
        >
          <Plus size={16} />
          新建 Agent
        </button>
      </div>

      {/* Search */}
      <div className="mb-6 flex items-center gap-4">
        <div className="flex items-center gap-2 rounded-lg bg-bg-surface border border-border-default px-3 py-2">
          <Search size={16} className="text-text-secondary" />
          <input
            type="text"
            placeholder="搜索 Agent 名称或 ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {/* My Agent */}
      {myAgent && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <User size={18} className="text-accent-green" />
            <h2 className="text-base font-semibold text-text-primary">我的 Agent</h2>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <AgentCard agent={myAgent} showDelete={false} />
          </div>
        </div>
      )}

      {/* System Agents */}
      {systemAgents.length > 0 && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <Shield size={18} className="text-accent-purple" />
            <h2 className="text-base font-semibold text-text-primary">系统 Agents</h2>
            <span className="ml-2 rounded-full bg-accent-purple/10 px-2 py-0.5 text-xs text-accent-purple">{systemAgents.length}</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {filterAgents(systemAgents).map(agent => (
              <AgentCard key={agent.id} agent={agent} showDelete={false} />
            ))}
          </div>
        </div>
      )}

      {/* Other User Agents */}
      {otherAgents.length > 0 && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Bot size={18} className="text-accent-blue" />
            <h2 className="text-base font-semibold text-text-primary">其他用户 Agents</h2>
            <span className="ml-2 rounded-full bg-accent-blue/10 px-2 py-0.5 text-xs text-accent-blue">{otherAgents.length}</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {filterAgents(otherAgents).map(agent => (
              <AgentCard key={agent.id} agent={agent} showDelete={true} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
