import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { getMe, listAgents } from '../lib/api'
import type { AuthUser } from '../lib/api'
import {
  LayoutDashboard,
  Bot,
  Zap,
  Radio,
  Brain,
  FolderOpen,
  BookOpen,
  MessageSquare,
  Clock,
  Code2,
  Settings,
  User,
  Users,
} from 'lucide-react'


export default function Sidebar() {
  const location = useLocation()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [agentCount, setAgentCount] = useState<number>(0)

  useEffect(() => {
    getMe().then(setUser).catch(() => {})
    listAgents().then(r => setAgentCount(r.agents?.length ?? 0)).catch(() => {})
  }, [])

  const isAdmin = user?.role === 'admin'

  const navSections = [
    // Admin-only: 仪表盘放最上面
    ...(isAdmin ? [{
      label: '概览',
      items: [{ to: '/dashboard', icon: LayoutDashboard, label: '仪表盘' }],
    }] : []),
    // Regular user visible sections
    {
      label: '技能',
      items: [
        { to: '/skills', icon: Zap, label: '技能商店' },
        { to: '/chat', icon: MessageSquare, label: '会话' },
        { to: '/files', icon: FolderOpen, label: '文件管理' },
      ],
    },
    // Admin-only sections
    ...(isAdmin ? [{
      label: 'Agents',
      items: [{ to: '/agents', icon: Bot, label: 'Agents', badgeKey: 'agents' }],
    }] : []),
    ...(isAdmin ? [{
      label: '平台管理',
      items: [
        { to: '/channels', icon: Radio, label: '渠道管理' },
        { to: '/models', icon: Brain, label: 'AI 模型' },
        { to: '/knowledge', icon: BookOpen, label: '知识库' },
        { to: '/cron', icon: Clock, label: '定时任务' },
        { to: '/api', icon: Code2, label: 'API设定' },
      ],
    }] : []),
    ...(isAdmin ? [{
      label: '管理',
      items: [
        { to: '/admin/users', icon: Users, label: '用户管理' },
        { to: '/admin/skills', icon: Zap, label: '技能管理' },
        { to: '/settings', icon: Settings, label: '系统设置' },
        { to: '/sessions', icon: Clock, label: '会话历史' },
      ],
    }] : []),
  ]

  return (
    <aside className="flex w-56 flex-col bg-bg-elevated border-r border-border-default">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-blue text-sm font-bold text-white">
          SC
        </div>
        <div>
          <div className="text-sm font-semibold text-text-primary">AgentClaw</div>
          <div className="text-xs text-text-secondary">技能商店平台 v2026.3</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {navSections.map(section => (
          <div key={section.label} className="mb-4">
            <div className="mb-1.5 px-3 text-xs font-medium uppercase tracking-wider text-text-tertiary">
              {section.label}
            </div>
            {section.items.map(item => {
              const Icon = item.icon
              const isActive = location.pathname === item.to ||
                (item.to !== '/dashboard' && location.pathname.startsWith(item.to))
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-accent-blue/15 text-accent-blue'
                      : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
                  }`}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                  {'badgeKey' in item && item.badgeKey === 'agents' && agentCount > 0 && (
                    <span className="ml-auto flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent-blue/20 px-1 text-xs text-accent-blue">
                      {agentCount}
                    </span>
                  )}
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User */}
      <NavLink
        to="/profile"
        className={`border-t border-border-default px-4 py-3 flex items-center gap-3 transition-colors ${
          location.pathname === '/profile'
            ? 'bg-accent-blue/15 text-accent-blue'
            : 'text-text-primary hover:bg-bg-surface'
        }`}
      >
        <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium text-white ${
          isAdmin ? 'bg-accent-green' : 'bg-accent-purple'
        }`}>
          <User size={16} />
        </div>
        <div>
          <div className="text-sm font-medium">
            {user?.username ?? 'Loading...'}
            {isAdmin && <span className="ml-1 text-xs text-accent-green">(管理员)</span>}
          </div>
          <div className="text-xs text-text-secondary">{user?.email ?? ''}</div>
        </div>
      </NavLink>
    </aside>
  )
}
