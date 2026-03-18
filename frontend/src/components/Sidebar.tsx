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
  PanelLeftClose,
} from 'lucide-react'

interface Props {
  collapsed: boolean
  onToggle: () => void
}

export default function Sidebar({ collapsed, onToggle }: Props) {
  const location = useLocation()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [agentCount, setAgentCount] = useState<number>(0)

  useEffect(() => {
    getMe().then(setUser).catch(() => {})
    listAgents().then(r => setAgentCount(r.agents?.length ?? 0)).catch(() => {})
  }, [])

  const isAdmin = user?.role === 'admin'

  const navSections = [
    ...(isAdmin ? [{
      label: '概览',
      items: [{ to: '/dashboard', icon: LayoutDashboard, label: '仪表盘' }],
    }] : []),
    {
      label: '技能',
      items: [
        { to: '/skills', icon: Zap, label: '技能商店' },
        { to: '/files', icon: FolderOpen, label: '文件管理' },
      ],
    },
    {
      label: '会话',
      items: [
        { to: '/chat', icon: MessageSquare, label: '会话' },
      ],
    },
    {
      label: 'Agent',
      items: [
        { to: '/agents', icon: Bot, label: 'Agents', badgeKey: 'agents' },
        { to: '/cron', icon: Clock, label: '定时任务' },
        { to: '/api', icon: Code2, label: 'API 访问' },
      ],
    },
    ...(isAdmin ? [{
      label: '平台管理',
      items: [
        { to: '/channels', icon: Radio, label: '渠道管理' },
        { to: '/models', icon: Brain, label: 'AI 模型' },
        { to: '/knowledge', icon: BookOpen, label: '知识库' },
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

  // Shared fade style for all label-type content
  const labelStyle: React.CSSProperties = {
    opacity: collapsed ? 0 : 1,
    maxWidth: collapsed ? 0 : 160,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    transition: 'opacity 0.25s ease, max-width 0.3s ease',
    flexShrink: 0,
  }

  return (
    <aside
      style={{ width: collapsed ? 56 : 224, transition: 'width 0.3s ease' }}
      className="flex flex-col bg-bg-elevated border-r border-border-default overflow-hidden shrink-0"
    >
      {/* Logo + toggle */}
      <div className="flex items-center border-b border-border-default px-3 py-4 gap-2">
        <div
          onClick={collapsed ? onToggle : undefined}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${collapsed ? 'cursor-pointer hover:ring-2 hover:ring-accent-blue/40' : ''}`}
          title={collapsed ? '展开菜单' : undefined}
        >
          <img src="/logo.png" alt="AgentClaw" className="h-8 w-8 scale-150 object-contain" />
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-text-primary truncate">AgentClaw</div>
              <div className="text-xs text-text-secondary truncate">多租户 Agent 平台</div>
            </div>
            <button
              onClick={onToggle}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors"
              title="收起菜单"
            >
              <PanelLeftClose size={15} />
            </button>
          </>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {navSections.map(section => (
          <div key={section.label} className="mb-3">
            <div style={{
              ...labelStyle,
              maxWidth: collapsed ? 0 : 200,
              marginBottom: collapsed ? 0 : 4,
              paddingLeft: 8,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }} className="text-text-tertiary">
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
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 rounded-lg py-2 px-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-accent-blue/15 text-accent-blue'
                      : 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
                  }`}
                >
                  <Icon size={18} className="shrink-0" />
                  <span style={labelStyle}>
                    {item.label}
                  </span>
                  {'badgeKey' in item && item.badgeKey === 'agents' && agentCount > 0 && (
                    <span style={{
                      opacity: collapsed ? 0 : 1,
                      maxWidth: collapsed ? 0 : 40,
                      overflow: 'hidden',
                      transition: 'opacity 0.25s ease, max-width 0.3s ease',
                      flexShrink: 0,
                    }} className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent-blue/20 px-1 text-xs text-accent-blue">
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
        title={collapsed ? (user?.username ?? '') : undefined}
        className={`border-t border-border-default py-3 px-2 flex items-center gap-3 transition-colors ${
          location.pathname === '/profile'
            ? 'bg-accent-blue/15 text-accent-blue'
            : 'text-text-primary hover:bg-bg-surface'
        }`}
      >
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white ${
          isAdmin ? 'bg-accent-green' : 'bg-accent-purple'
        }`}>
          <User size={16} />
        </div>
        <div style={labelStyle}>
          <div className="text-sm font-medium truncate">
            {user?.username ?? 'Loading...'}
            {isAdmin && <span className="ml-1 text-xs text-accent-green">(管理员)</span>}
          </div>
          <div className="text-xs text-text-secondary truncate">{user?.email ?? ''}</div>
        </div>
      </NavLink>
    </aside>
  )
}
