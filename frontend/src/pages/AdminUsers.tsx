import { useState, useEffect } from 'react'
import {
  Users,
  Container,
  Trash2,
  User,
  Loader2,
  RefreshCw,
  TrendingUp,
  X,
  ArrowUp,
  ArrowDown,
  CheckCircle,
  XCircle,
  Clock,
  Circle,
} from 'lucide-react'

interface UserSummary {
  id: string
  username: string
  email: string
  role: string
  quota_tier: string
  is_active: boolean
  container_status: string | null
  container_cpu: number | null
  container_memory: string | null
  container_memory_percent: number | null
  tokens_used_today: number
}

// Quota limits based on tier
const QUOTA_LIMITS: Record<string, number> = {
  free: 10000,
  basic: 50000,
  pro: 200000,
}

interface UsageSummary {
  total_tokens_today: number
  total_users: number
  active_containers: number
}

interface MigrationStep {
  name: string
  status: string  // pending | running | done | failed
  detail?: string
  started_at?: string
  completed_at?: string
}

interface MigrationRecord {
  id: string
  user_id: string
  direction: string
  from_tier: string
  to_tier: string
  status: string  // pending | running | completed | failed
  error?: string
  created_at: string
  completed_at?: string
  steps: MigrationStep[]
}

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  basic: 'Basic',
  pro: 'Pro',
  enterprise: 'Enterprise',
}

const STEP_LABELS: Record<string, string> = {
  create_container: '创建容器',
  provision_agents: '创建 Agent',
  copy_data: '复制数据',
  update_routing: '更新路由',
  update_user_tier: '更新用户 Tier',
  destroy_container: '销毁容器',
  notify: '发送通知',
  provision_shared_agents: '创建 Shared Agent',
}

function MigrationModal({ userId, username, currentTier, onClose }: {
  userId: string
  username: string
  currentTier: string
  onClose: () => void
}) {
  const [migrationId, setMigrationId] = useState<string | null>(null)
  const [record, setRecord] = useState<MigrationRecord | null>(null)
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)

  // Poll migration status
  useEffect(() => {
    if (!migrationId || !['pending', 'running'].includes(record?.status ?? '')) return
    setPolling(true)
    const interval = setInterval(async () => {
      try {
        const token = localStorage.getItem('openclaw_access_token')
        const res = await fetch(`/api/admin/migrations/${migrationId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data: MigrationRecord = await res.json()
          setRecord(data)
          if (!['pending', 'running'].includes(data.status)) {
            clearInterval(interval)
          }
        }
      } catch { /* ignore polling errors */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [migrationId, record?.status])

  const startMigration = async (direction: 'upgrade' | 'downgrade') => {
    setError('')
    try {
      const token = localStorage.getItem('openclaw_access_token')
      const res = await fetch(`/api/admin/users/${userId}/migrate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ direction }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '迁移失败')
      setMigrationId(data.id)
      setRecord(data)
    } catch (e: any) {
      setError(e.message)
    }
  }

  const isRunning = record && ['pending', 'running'].includes(record.status)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[520px] max-w-[90vw] rounded-xl border border-border-default bg-bg-elevated shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Tier 迁移</h3>
            <p className="mt-0.5 text-sm text-text-secondary">{username}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {!migrationId ? (
            // Direction selection
            <div className="space-y-4">
              <div className="flex items-center justify-center gap-4 rounded-lg border border-border-default bg-bg-surface p-4">
                <span className="rounded bg-accent-blue/20 px-3 py-1 text-sm font-medium text-accent-blue">
                  {TIER_LABELS[currentTier] || currentTier}
                </span>
                <ArrowUp size={18} className="text-text-secondary" />
                <span className="rounded bg-accent-green/20 px-3 py-1 text-sm font-medium text-accent-green">
                  Pro
                </span>
              </div>
              <p className="text-center text-sm text-text-secondary">
                升级后用户将获得独立 Docker 容器，数据将自动迁移。
              </p>
              {error && (
                <div className="rounded border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
                  {error}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => startMigration('upgrade')}
                  disabled={currentTier === 'pro' || currentTier === 'enterprise'}
                  className="flex-1 rounded-lg bg-accent-green px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-green/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp size={14} className="mr-1.5 inline" />
                  升级到 Pro
                </button>
                <button
                  onClick={() => startMigration('downgrade')}
                  disabled={currentTier !== 'pro' && currentTier !== 'enterprise'}
                  className="flex-1 rounded-lg border border-border-default bg-bg-surface px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-bg-surface/80 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowDown size={14} className="mr-1.5 inline" />
                  降级到 Free
                </button>
              </div>
            </div>
          ) : (
            // Progress view
            <div className="space-y-4">
              {/* Status banner */}
              <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium ${
                record?.status === 'completed'
                  ? 'bg-accent-green/10 text-accent-green'
                  : record?.status === 'failed'
                  ? 'bg-accent-red/10 text-accent-red'
                  : 'bg-accent-blue/10 text-accent-blue'
              }`}>
                {isRunning && <Loader2 size={14} className="animate-spin" />}
                {record?.status === 'completed' && <CheckCircle size={14} />}
                {record?.status === 'failed' && <XCircle size={14} />}
                {record?.status === 'pending' && <Clock size={14} />}
                {record?.status === 'running' && '迁移中…'}
                {record?.status === 'completed' && '迁移完成'}
                {record?.status === 'failed' && '迁移失败'}
                {record?.status === 'rolled_back' && '已回滚'}
                {record?.status === 'pending' && '等待开始'}
              </div>

              {record?.error && (
                <div className="rounded border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
                  {record.error}
                </div>
              )}

              {/* Steps */}
              <div className="space-y-2">
                {(record?.steps ?? []).map((step, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <div className="flex-shrink-0">
                      {step.status === 'done' ? (
                        <CheckCircle size={16} className="text-accent-green" />
                      ) : step.status === 'failed' ? (
                        <XCircle size={16} className="text-accent-red" />
                      ) : step.status === 'running' ? (
                        <Loader2 size={16} className="animate-spin text-accent-blue" />
                      ) : (
                        <Circle size={16} className="text-text-secondary/40" />
                      )}
                    </div>
                    <span className={`flex-1 ${
                      step.status === 'done' ? 'text-text-primary' :
                      step.status === 'failed' ? 'text-accent-red' :
                      step.status === 'running' ? 'text-accent-blue font-medium' :
                      'text-text-secondary/50'
                    }`}>
                      {STEP_LABELS[step.name] || step.name}
                    </span>
                    {step.detail && (
                      <span className="text-xs text-text-secondary">{step.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AdminUsers() {
  const [users, setUsers] = useState<UserSummary[]>([])
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [migratingUser, setMigratingUser] = useState<{ id: string; username: string; tier: string } | null>(null)

  const fetchData = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('openclaw_access_token')
      const [usersRes, usageRes] = await Promise.all([
        fetch('/api/admin/users', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch('/api/admin/usage/summary', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
      ])
      setUsers(usersRes)
      setUsage(usageRes)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const updateRole = async (userId: string, role: string) => {
    const token = localStorage.getItem('openclaw_access_token')
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role }),
    })
    fetchData()
  }

  const deleteContainer = async (userId: string) => {
    if (!confirm('确定要删除该用户的容器吗？数据将保留但容器会被删除。')) return
    const token = localStorage.getItem('openclaw_access_token')
    await fetch(`/api/admin/users/${userId}/container`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    fetchData()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-text-secondary" size={32} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-accent-red/30 bg-accent-red/10 p-4 text-accent-red">
        <p>加载失败: {error}</p>
        <p className="text-sm text-accent-red/70 mt-2">请确保你有管理员权限</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">用户管理</h1>
          <p className="mt-1 text-sm text-text-secondary">管理平台用户和容器</p>
        </div>
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          刷新数据
        </button>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border-default bg-bg-surface p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-blue">
              <Users size={20} className="text-white" />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary">{usage?.total_users ?? 0}</div>
              <div className="text-sm text-text-secondary">注册用户</div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border-default bg-bg-surface p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-green">
              <Container size={20} className="text-white" />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary">{usage?.active_containers ?? 0}</div>
              <div className="text-sm text-text-secondary">运行中容器</div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border-default bg-bg-surface p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-purple">
              <TrendingUp size={20} className="text-white" />
            </div>
            <div>
              <div className="text-2xl font-bold text-text-primary">{(((usage?.total_tokens_today ?? 0)) / 1000).toFixed(1)}K</div>
              <div className="text-sm text-text-secondary">今日 Token 消耗</div>
            </div>
          </div>
        </div>
      </div>

      {/* Users Table */}
      <div className="rounded-xl border border-border-default bg-bg-surface">
        <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
          <div className="flex items-center gap-2">
            <Users size={20} className="text-accent-blue" />
            <h2 className="text-base font-semibold text-text-primary">用户列表</h2>
          </div>
          <span className="text-sm text-text-secondary">{users.length} 个用户</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-text-secondary border-b border-border-default">
                <th className="px-6 py-3 font-medium">用户</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">Tier</th>
                <th className="px-4 py-3 font-medium">容器状态</th>
                <th className="px-4 py-3 font-medium">CPU</th>
                <th className="px-4 py-3 font-medium">内存</th>
                <th className="px-4 py-3 font-medium">用量/配额</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} className="border-b border-border-default/50 hover:bg-bg-surface/50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-purple">
                        <User size={16} className="text-white" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-text-primary">{user.username}</div>
                        <div className="text-xs text-text-secondary">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <select
                      value={user.role}
                      onChange={(e) => updateRole(user.id, e.target.value)}
                      className="rounded border border-border-default bg-bg-base px-2 py-1 text-sm text-text-primary"
                    >
                      <option value="user">用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                      user.quota_tier === 'pro' || user.quota_tier === 'enterprise'
                        ? 'bg-accent-purple/20 text-accent-purple'
                        : user.quota_tier === 'basic'
                        ? 'bg-accent-blue/20 text-accent-blue'
                        : 'bg-text-secondary/20 text-text-secondary'
                    }`}>
                      {TIER_LABELS[user.quota_tier] || user.quota_tier}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`flex items-center gap-1.5 text-xs ${
                      user.container_status === 'running' ? 'text-accent-green' :
                      user.container_status === 'paused' ? 'text-accent-yellow' :
                      user.container_status ? 'text-text-secondary' : 'text-text-secondary/50'
                    }`}>
                      <span className={`h-2 w-2 rounded-full ${
                        user.container_status === 'running' ? 'bg-accent-green' :
                        user.container_status === 'paused' ? 'bg-accent-yellow' :
                        'bg-text-secondary/50'
                      }`} />
                      {user.container_status || '无容器'}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-sm text-text-secondary">
                    {user.container_cpu != null ? `${user.container_cpu.toFixed(1)}%` : '-'}
                  </td>
                  <td className="px-4 py-4 text-sm text-text-secondary">
                    {user.container_memory != null ? (
                      <span title={`内存使用率: ${user.container_memory_percent?.toFixed(1) ?? '-'}%`}>
                        {user.container_memory}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-4 text-sm text-text-secondary">
                    {(() => {
                      const used = user.tokens_used_today ?? 0
                      const limit = QUOTA_LIMITS[user.quota_tier] ?? QUOTA_LIMITS.free
                      return `${Math.round(used)}/${Math.round(limit)}`
                    })()}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setMigratingUser({ id: user.id, username: user.username, tier: user.quota_tier })}
                        className="rounded p-1.5 text-text-secondary hover:bg-accent-blue/10 hover:text-accent-blue"
                        title="Tier 迁移"
                      >
                        <TrendingUp size={16} />
                      </button>
                      {user.container_status && (
                        <button
                          onClick={() => deleteContainer(user.id)}
                          className="rounded p-1.5 text-text-secondary hover:bg-bg-surface hover:text-accent-red"
                          title="删除容器"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {migratingUser && (
        <MigrationModal
          userId={migratingUser.id}
          username={migratingUser.username}
          currentTier={migratingUser.tier}
          onClose={() => {
            setMigratingUser(null)
            fetchData()
          }}
        />
      )}
    </div>
  )
}
