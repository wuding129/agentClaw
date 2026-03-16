/**
 * 新主题下的 Dashboard 示例
 * 展示玻璃拟态效果
 */

import { useState, useEffect } from 'react'
import { Bot, Wrench, MessageSquare, Users, Activity, Zap } from 'lucide-react'
import { GlassCard, GradientButton, GradientTitle, GlassInput } from '../components/ui/GlassCard'
import { fetchAgents } from '../store/agents'
import type { BackendAgent } from '../types/agent'

// 统计卡片 - 新主题
function StatCard({
  icon: Icon,
  label,
  value,
  trend,
  color,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  trend?: string
  color: 'blue' | 'green' | 'purple' | 'yellow'
}) {
  const colorClasses = {
    blue: 'from-accent-blue/20 to-accent-blue/5',
    green: 'from-accent-green/20 to-accent-green/5',
    purple: 'from-accent-purple/20 to-accent-purple/5',
    yellow: 'from-accent-yellow/20 to-accent-yellow/5',
  }

  const iconColors = {
    blue: 'text-accent-blue bg-accent-blue/10',
    green: 'text-accent-green bg-accent-green/10',
    purple: 'text-accent-purple bg-accent-purple/10',
    yellow: 'text-accent-yellow bg-accent-yellow/10',
  }

  return (
    <GlassCard variant="elevated" className={`bg-gradient-to-br ${colorClasses[color]}`}>
      <div className="flex items-start justify-between">
        <div className={`p-2.5 rounded-lg ${iconColors[color]}`}>
          <Icon size={20} />
        </div>
        {trend && (
          <span className="text-xs font-medium text-accent-green">
            +{trend}
          </span>
        )}
      </div>
      <div className="mt-4">
        <div className="text-3xl font-bold text-text-primary">{value}</div>
        <div className="text-sm text-text-secondary mt-0.5">{label}</div>
      </div>
    </GlassCard>
  )
}

// Agent 列表项 - 新主题
function AgentRow({ agent, isSystem }: { agent: BackendAgent; isSystem?: boolean }) {
  return (
    <div className="group flex items-center gap-4 p-3 rounded-xl hover:bg-white/[0.03] transition-all duration-200">
      {/* 头像 */}
      <div className="relative">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${
          isSystem
            ? 'bg-gradient-to-br from-accent-purple/20 to-accent-blue/20'
            : 'bg-gradient-to-br from-accent-blue/20 to-accent-green/20'
        }`}>
          {agent.identity?.emoji || (isSystem ? '🤖' : '👤')}
        </div>
        {/* 在线状态指示器 */}
        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-green shadow-sm shadow-black/50" />
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-primary truncate">
            {(agent as any).displayName || agent.name}
          </span>
          {isSystem && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-accent-purple/10 text-accent-purple-light">
              系统
            </span>
          )}
        </div>
        <div className="text-xs text-text-tertiary font-mono mt-0.5">
          {agent.id.slice(0, 16)}...
        </div>
      </div>

      {/* 状态 - 更简洁 */}
      <div className={`w-2 h-2 rounded-full ${isSystem ? 'bg-accent-green' : 'bg-accent-blue'} ${!isSystem && 'animate-pulse'}`} />

      {/* 操作按钮 - 悬停显示 */}
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <GradientButton variant="ghost" size="sm">
          <MessageSquare size={14} />
        </GradientButton>
        <GradientButton variant="ghost" size="sm">
          查看
        </GradientButton>
      </div>
    </div>
  )
}

export default function DashboardNewTheme() {
  const [agents, setAgents] = useState<BackendAgent[]>([])
  const [loading, setLoading] = useState(true)

  const systemAgents = agents.filter(a => ['main', 'skill-reviewer'].includes(a.id))
  const userAgents = agents.filter(a => !['main', 'skill-reviewer'].includes(a.id))

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex items-center gap-3 text-text-secondary">
          <div className="w-5 h-5 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
          加载中...
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg-base p-8">
      {/* 顶部背景光效 */}
      <div className="fixed inset-x-0 top-0 h-96 bg-gradient-glow-blue pointer-events-none" />

      <div className="relative max-w-7xl mx-auto space-y-8">
        {/* 头部 */}
        <div className="flex items-end justify-between">
          <div>
            <GradientTitle>仪表盘</GradientTitle>
            <p className="text-text-secondary mt-1">Agent 运营总览与系统状态监控</p>
          </div>
          <div className="flex items-center gap-3">
            <GlassInput
              placeholder="搜索 Agent..."
              className="w-64"
            />
            <GradientButton>
              <Zap size={16} className="mr-2" />
              快速操作
            </GradientButton>
          </div>
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={Bot}
            label="Agent 总数"
            value={agents.length}
            trend="12%"
            color="blue"
          />
          <StatCard
            icon={Activity}
            label="在线 Agent"
            value={userAgents.length || 5}
            color="green"
          />
          <StatCard
            icon={Users}
            label="活跃用户"
            value="128"
            trend="8%"
            color="purple"
          />
          <StatCard
            icon={Wrench}
            label="技能总数"
            value="42"
            color="yellow"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 系统 Agents */}
          <div className="lg:col-span-2 space-y-4">
            <GlassCard
              variant="elevated"
              header={
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot size={18} className="text-accent-purple" />
                    <span className="font-medium text-text-primary">系统 Agents</span>
                    <span className="px-2 py-0.5 text-xs rounded-full bg-accent-purple/10 text-accent-purple-light">
                      {systemAgents.length}
                    </span>
                  </div>
                </div>
              }
            >
              <div className="space-y-2">
                {systemAgents.map(agent => (
                  <AgentRow key={agent.id} agent={agent} isSystem />
                ))}
              </div>
            </GlassCard>

            {/* 用户 Agents */}
            <GlassCard
              header={
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users size={18} className="text-accent-blue" />
                    <span className="font-medium text-text-primary">用户 Agents</span>
                    <span className="px-2 py-0.5 text-xs rounded-full bg-accent-blue/10 text-accent-blue-light">
                      {userAgents.length}
                    </span>
                  </div>
                  <GradientButton variant="ghost" size="sm">
                    查看全部
                  </GradientButton>
                </div>
              }
            >
              <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                {userAgents.map(agent => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </div>
            </GlassCard>
          </div>

          {/* 侧边栏 */}
          <div className="space-y-4">
            {/* 快速统计 */}
            <GlassCard
              header={
                <div className="flex items-center gap-2">
                  <Activity size={18} className="text-accent-green" />
                  <span className="font-medium text-text-primary">系统状态</span>
                </div>
              }
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">CPU 使用率</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-bg-floating rounded-full overflow-hidden">
                      <div className="w-1/3 h-full bg-accent-green rounded-full" />
                    </div>
                    <span className="text-sm text-text-primary">34%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">内存使用</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-bg-floating rounded-full overflow-hidden">
                      <div className="w-1/2 h-full bg-accent-blue rounded-full" />
                    </div>
                    <span className="text-sm text-text-primary">52%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">存储空间</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 bg-bg-floating rounded-full overflow-hidden">
                      <div className="w-3/4 h-full bg-accent-yellow rounded-full" />
                    </div>
                    <span className="text-sm text-text-primary">78%</span>
                  </div>
                </div>
              </div>
            </GlassCard>

            {/* 最近活动 */}
            <GlassCard
              header={
                <div className="flex items-center gap-2">
                  <Zap size={18} className="text-accent-yellow" />
                  <span className="font-medium text-text-primary">最近活动</span>
                </div>
              }
            >
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-accent-green" />
                  <div>
                    <div className="text-text-primary">Agent skill-reviewer 启动成功</div>
                    <div className="text-text-tertiary text-xs">2 分钟前</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-accent-blue" />
                  <div>
                    <div className="text-text-primary">新用户注册: test3</div>
                    <div className="text-text-tertiary text-xs">15 分钟前</div>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-accent-purple" />
                  <div>
                    <div className="text-text-primary">技能 weather 安装完成</div>
                    <div className="text-text-tertiary text-xs">1 小时前</div>
                  </div>
                </div>
              </div>
            </GlassCard>
          </div>
        </div>
      </div>
    </div>
  )
}
