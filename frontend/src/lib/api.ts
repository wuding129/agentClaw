// API client for OpenClaw Platform Gateway (multi-tenant mode)

const API_URL = import.meta.env.VITE_API_URL || ''

// ---------------------------------------------------------------------------
// Constants (to prevent typos and magic values)
// ---------------------------------------------------------------------------

/** Agent visibility scopes for list operations */
export const AgentScope = {
  /** Only current user's agent */
  Self: 'self' as const,
  /** All agents (admin only) */
  All: 'all' as const,
} as const

export type AgentScopeType = typeof AgentScope[keyof typeof AgentScope]

/** Well-known system agent IDs */
export const SystemAgents = {
  Main: 'main',
  SkillReviewer: 'skill-reviewer',
} as const

export const SystemAgentIds = [SystemAgents.Main, SystemAgents.SkillReviewer] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface AuthUser {
  id: string
  username: string
  email: string
  role: string
  quota_tier: string
  is_active: boolean
  created_at: string
}

export interface AgentInfo {
  id: string
  name: string
  displayName?: string
  identity?: {
    name?: string
    emoji?: string
    avatar?: string
    theme?: string
    avatarUrl?: string
  }
}

export interface AgentListResult {
  defaultId: string
  mainKey: string
  scope: string
  agents: AgentInfo[]
}

export interface AgentFileEntry {
  name: string
  path: string
  missing: boolean
  size: number
  updatedAtMs: number
}

export interface AgentFilesResult {
  agentId: string
  workspace: string
  files: AgentFileEntry[]
}

export interface AgentFileContent {
  agentId: string
  workspace: string
  file: { name: string; content: string }
}

export interface Session {
  key: string
  agentId?: string
  title?: string
  created_at: string | null
  updated_at: string | null
}

export interface SessionDetail {
  key: string
  messages: Array<{
    role: string
    content: string
    timestamp: string | null
  }>
  created_at: string | null
  updated_at: string | null
}

export interface Skill {
  name: string
  description: string
  source?: string
  disabled?: boolean
  compatible?: boolean
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_KEY = 'openclaw_access_token'
const REFRESH_TOKEN_KEY = 'openclaw_refresh_token'

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
}

function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

export function isLoggedIn(): boolean {
  return getAccessToken() !== null
}

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

let refreshPromise: Promise<boolean> | null = null

async function tryRefreshToken(): Promise<boolean> {
  const refresh = getRefreshToken()
  if (!refresh) return false

  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      })
      if (!res.ok) return false
      const data: TokenResponse = await res.json()
      setTokens(data.access_token, data.refresh_token)
      return true
    } catch {
      return false
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

export async function fetchJSON<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let res = await fetch(`${API_URL}${path}`, { ...options, headers })

  // On 401 attempt a silent token refresh and retry once
  if (res.status === 401 && token) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getAccessToken()}`
      res = await fetch(`${API_URL}${path}`, { ...options, headers })
    } else {
      clearTokens()
      window.location.href = '/login'
      throw new Error('Session expired')
    }
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${res.status}: ${body}`)
  }

  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Auth functions
// ---------------------------------------------------------------------------

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export async function login(
  username: string,
  password: string,
): Promise<TokenResponse> {
  const data = await fetchJSON<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setTokens(data.access_token, data.refresh_token)
  return data
}

export function logout(): void {
  clearTokens()
  window.location.href = '/login'
}

export async function getMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/api/auth/me')
}

export async function generateApiToken(): Promise<{ api_token: string; expires_in_days: number }> {
  return fetchJSON<{ api_token: string; expires_in_days: number }>('/api/auth/api-token', {
    method: 'POST',
  })
}

export async function changepassword(
  currentpassword: string,
  newpassword: string,
): Promise<{ ok: boolean; message: string }> {
  return fetchJSON<{ ok: boolean; message: string }>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentpassword, new_password: newpassword }),
  })
}

// ---------------------------------------------------------------------------
// Agent functions
// ---------------------------------------------------------------------------

export async function listAgents(scope?: AgentScopeType): Promise<AgentListResult> {
  const query = scope ? `?scope=${scope}` : ''
  return fetchJSON<AgentListResult>(`/api/openclaw/agents${query}`)
}

export async function createAgent(
  name: string,
  workspace?: string,
  installedSkills?: string[],
  model?: string,
): Promise<AgentInfo> {
  return fetchJSON<AgentInfo>('/api/openclaw/agents', {
    method: 'POST',
    body: JSON.stringify({ name, workspace, installed_skills: installedSkills, model }),
  })
}

export async function updateAgent(
  agentId: string,
  updates: { name?: string; workspace?: string; model?: string; avatar?: string },
): Promise<Record<string, unknown>> {
  return fetchJSON<Record<string, unknown>>(`/api/openclaw/agents/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
}

export async function deleteAgent(
  agentId: string,
  deleteFiles?: boolean,
): Promise<void> {
  const params = deleteFiles ? '?delete_files=true' : ''
  await fetchJSON<unknown>(`/api/openclaw/agents/${encodeURIComponent(agentId)}${params}`, {
    method: 'DELETE',
  })
}

export async function listAgentFiles(
  agentId: string,
): Promise<AgentFilesResult> {
  return fetchJSON<AgentFilesResult>(`/api/openclaw/agents/${encodeURIComponent(agentId)}/files`)
}

export async function getAgentFile(
  agentId: string,
  name: string,
): Promise<AgentFileContent> {
  return fetchJSON<AgentFileContent>(`/api/openclaw/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`)
}

export async function setAgentFile(
  agentId: string,
  name: string,
  content: string,
): Promise<void> {
  await fetchJSON<unknown>(
    `/api/openclaw/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
  )
}

// ---------------------------------------------------------------------------
// Session functions
// ---------------------------------------------------------------------------

export async function listSessions(agentId?: string, scope?: AgentScopeType): Promise<Session[]> {
  const params = new URLSearchParams()
  if (agentId) params.append('agentId', agentId)
  if (scope) params.append('scope', scope)
  const url = params.toString()
    ? `/api/openclaw/sessions?${params.toString()}`
    : '/api/openclaw/sessions'
  return fetchJSON<Session[]>(url)
}

export async function getSession(key: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/api/openclaw/sessions/${encodeURIComponent(key)}`)
}

export async function deleteSession(key: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/sessions/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// ---------------------------------------------------------------------------
// Chat functions
// ---------------------------------------------------------------------------

export async function sendChatMessage(
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; runId: string | null }> {
  return fetchJSON<{ ok: boolean; runId: string | null }>(
    `/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  )
}

export async function uploadFileToWorkspace(
  file: File,
  targetDir = 'workspace/uploads',
): Promise<{ name: string; path: string }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('path', targetDir)

  const token = getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_URL}/api/openclaw/filemanager/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Upload failed')
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Other
// ---------------------------------------------------------------------------

export async function listSkills(): Promise<Skill[]> {
  return fetchJSON<Skill[]>('/api/openclaw/skills')
}

// Get skills for a specific agent (uses X-Agent-Id header)
export async function listSkillsForAgent(agentId: string): Promise<Skill[]> {
  return fetchJSON<Skill[]>('/api/openclaw/skills', {
    headers: { 'X-Agent-Id': agentId },
  })
}

export async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  await fetchJSON(`/api/openclaw/skills/${encodeURIComponent(name)}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

// Toggle skill for a specific agent (uses X-Agent-Id header)
export async function toggleAgentSkill(agentId: string, name: string, enabled: boolean): Promise<void> {
  await fetchJSON(`/api/openclaw/skills/${encodeURIComponent(name)}/toggle`, {
    method: 'PUT',
    headers: { 'X-Agent-Id': agentId },
    body: JSON.stringify({ enabled }),
  })
}

export async function getStatus(): Promise<Record<string, unknown>> {
  return fetchJSON<Record<string, unknown>>('/api/openclaw/status')
}

export async function ping(): Promise<{ message: string }> {
  const res = await fetch(`${API_URL}/api/ping`)
  if (!res.ok) throw new Error(`Ping failed: ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// Cron Jobs
// ---------------------------------------------------------------------------

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule_kind: string
  schedule_display: string
  schedule_expr: string | null
  schedule_every_ms: number | null
  message: string
  deliver: boolean
  channel: string | null
  to: string | null
  next_run_at_ms: number | null
  last_run_at_ms: number | null
  last_status: string | null
  last_error: string | null
  created_at_ms: number
}

export async function listCronJobs(includeDisabled = true): Promise<CronJob[]> {
  const params = includeDisabled ? '?include_disabled=true' : ''
  return fetchJSON<CronJob[]>(`/api/openclaw/cron/jobs${params}`)
}

export async function createCronJob(params: {
  name: string
  message: string
  every_seconds?: number
  cron_expr?: string
  at_iso?: string
  deliver?: boolean
  channel?: string
  to?: string
}): Promise<CronJob> {
  return fetchJSON<CronJob>('/api/openclaw/cron/jobs', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function deleteCronJob(jobId: string): Promise<void> {
  await fetchJSON<unknown>(`/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  })
}

export async function toggleCronJob(jobId: string, enabled: boolean): Promise<CronJob> {
  return fetchJSON<CronJob>(
    `/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}/toggle`,
    {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    },
  )
}

export async function runCronJob(jobId: string): Promise<void> {
  await fetchJSON<unknown>(
    `/api/openclaw/cron/jobs/${encodeURIComponent(jobId)}/run`,
    { method: 'POST' },
  )
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelChoice {
  id: string
  name: string
  provider: string
  contextWindow?: number
  reasoning?: boolean
}

export interface ModelsResult {
  models: ModelChoice[]
  configuredModel: string
  configuredProviders: Record<string, unknown>
}

export async function listModels(): Promise<ModelsResult> {
  return fetchJSON<ModelsResult>('/api/openclaw/models')
}

export async function updateModelsConfig(params: {
  providers?: Record<string, unknown>
  defaultModel?: string
}): Promise<void> {
  await fetchJSON<unknown>('/api/openclaw/models/config', {
    method: 'PUT',
    body: JSON.stringify(params),
  })
}

// ---------------------------------------------------------------------------
// File manager (~/.openclaw)
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number | null
  content_type?: string | null
  modified: string
}

export interface BrowseResult {
  type: 'directory'
  path: string
  root: string
  items: FileEntry[]
}

export interface FileContentResult {
  type: 'file'
  path: string
  name: string
  size: number
  content_type: string
  modified: string
  content?: string
}

export interface AgentWorkspace {
  id: string
  path: string
}

export async function listAgentWorkspaces(): Promise<{ workspaces: AgentWorkspace[] }> {
  return fetchJSON<{ workspaces: AgentWorkspace[] }>('/api/openclaw/filemanager/agents')
}

export async function browseFiles(dirPath = '', agentId?: string): Promise<BrowseResult> {
  const params = new URLSearchParams()
  if (dirPath) params.append('path', dirPath)
  if (agentId) params.append('agentId', agentId)
  const query = params.toString()
  return fetchJSON<BrowseResult>(`/api/openclaw/filemanager/browse${query ? `?${query}` : ''}`)
}

export async function downloadFileUrl(filePath: string, agentId?: string): Promise<string> {
  const token = getAccessToken()
  const params = new URLSearchParams()
  params.append('path', filePath)
  if (agentId) params.append('agentId', agentId)
  if (token) params.append('token', token)
  return `${API_URL}/api/openclaw/filemanager/download?${params.toString()}`
}

export async function uploadFile(file: File, dirPath = '', agentId?: string): Promise<FileEntry> {
  const formData = new FormData()
  formData.append('file', file)
  if (dirPath) formData.append('path', dirPath)
  if (agentId) formData.append('agentId', agentId)

  const token = getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_URL}/api/openclaw/filemanager/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Upload failed: ${body}`)
  }
  return res.json()
}

export async function deleteFile(filePath: string, agentId?: string): Promise<void> {
  const params = new URLSearchParams()
  params.append('path', filePath)
  if (agentId) params.append('agentId', agentId)
  await fetchJSON<unknown>(
    `/api/openclaw/filemanager/delete?${params.toString()}`,
    { method: 'DELETE' },
  )
}

export async function createDirectory(dirPath: string, agentId?: string): Promise<void> {
  const params = new URLSearchParams()
  params.append('path', dirPath)
  if (agentId) params.append('agentId', agentId)
  await fetchJSON<unknown>(
    `/api/openclaw/filemanager/mkdir?${params.toString()}`,
    { method: 'POST' },
  )
}

// ---------------------------------------------------------------------------
// Skills marketplace (skills.sh)
// ---------------------------------------------------------------------------

export interface SkillSearchResult {
  slug: string
  url: string
  installs: string
}

export async function searchSkills(
  query: string,
  limit = 10,
): Promise<{ results: SkillSearchResult[] }> {
  return fetchJSON<{ results: SkillSearchResult[] }>(
    '/api/openclaw/marketplaces/skills/search',
    {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    },
  )
}

export async function installSkill(
  slug: string,
): Promise<{ ok: boolean; output: string }> {
  return fetchJSON<{ ok: boolean; output: string }>(
    '/api/openclaw/marketplaces/skills/install',
    {
      method: 'POST',
      body: JSON.stringify({ slug }),
    },
  )
}

// ---------------------------------------------------------------------------
// Curated skills (platform-level)
// ---------------------------------------------------------------------------

export interface CuratedSkill {
  id: string
  name: string
  description: string
  author: string
  source_url: string | null
  category: string
  is_featured: boolean
  install_count: number
  created_by: string
  created_at: string
  installed: boolean
}

export interface SkillReviewResult {
  approved: boolean
  score: number
  issues: {
    severity: 'critical' | 'major' | 'minor'
    category: string
    message: string
    suggestion: string
  }[]
  summary: string
}

export interface SkillSubmission {
  id: string
  user_id: string
  skill_name: string
  description: string
  source_url: string | null
  status: string
  ai_review_result: SkillReviewResult | null
  admin_notes: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
}

export async function listCuratedSkills(): Promise<CuratedSkill[]> {
  return fetchJSON<CuratedSkill[]>('/api/skills/curated')
}

export async function installCuratedSkill(skillId: string): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(`/api/skills/curated/${encodeURIComponent(skillId)}/install`, {
    method: 'POST',
  })
}

export async function submitSkill(params: {
  skill_name: string
  description: string
  source_url?: string
}): Promise<{ ok: boolean; id: string }> {
  return fetchJSON<{ ok: boolean; id: string }>('/api/skills/submit', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function submitSkillWithFile(
  skillName: string,
  description: string,
  sourceUrl: string | undefined,
  file: File,
): Promise<{ ok: boolean; id: string }> {
  const formData = new FormData()
  formData.append('skill_name', skillName)
  formData.append('description', description)
  if (sourceUrl) {
    formData.append('source_url', sourceUrl)
  }
  formData.append('file', file)

  const response = await fetch('/api/skills/submit/upload', {
    method: 'POST',
    body: formData,
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('token')}`,
    },
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: 'Upload failed' }))
    throw new Error(err.detail || 'Upload failed')
  }
  return response.json()
}

export async function mySubmissions(): Promise<SkillSubmission[]> {
  return fetchJSON<SkillSubmission[]>('/api/skills/submissions/mine')
}

// Admin curated skills
export async function adminListCuratedSkills(): Promise<CuratedSkill[]> {
  return fetchJSON<CuratedSkill[]>('/api/admin/skills/curated')
}

export async function adminCreateCuratedSkill(params: {
  name: string
  description?: string
  author?: string
  source_url?: string
  category?: string
  is_featured?: boolean
}): Promise<{ ok: boolean; id: string }> {
  return fetchJSON<{ ok: boolean; id: string }>('/api/admin/skills/curated', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export async function adminUploadCuratedSkill(formData: FormData): Promise<{ ok: boolean; id: string; updated: boolean }> {
  const token = getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_URL}/api/admin/skills/curated/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${res.status}: ${body}`)
  }
  return res.json()
}

export async function adminUpdateCuratedSkill(skillId: string, params: {
  name?: string
  description?: string
  author?: string
  source_url?: string
  category?: string
  is_featured?: boolean
}): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(`/api/admin/skills/curated/${encodeURIComponent(skillId)}`, {
    method: 'PUT',
    body: JSON.stringify(params),
  })
}

export async function adminDeleteCuratedSkill(skillId: string): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(`/api/admin/skills/curated/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
  })
}

export async function adminListSubmissions(status?: string): Promise<SkillSubmission[]> {
  const params = status ? `?status_filter=${encodeURIComponent(status)}` : ''
  return fetchJSON<SkillSubmission[]>(`/api/admin/skills/submissions${params}`)
}

export async function adminApproveSubmission(id: string, notes?: string): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(`/api/admin/skills/submissions/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ admin_notes: notes }),
  })
}

export async function adminRejectSubmission(id: string, notes?: string): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(`/api/admin/skills/submissions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ admin_notes: notes }),
  })
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelAccountSnapshot {
  accountId: string
  name?: string | null
  enabled?: boolean | null
  configured?: boolean | null
  linked?: boolean | null
  running?: boolean | null
  connected?: boolean | null
  reconnectAttempts?: number | null
  lastConnectedAt?: number | null
  lastError?: string | null
  mode?: string
  webhookUrl?: string
  [key: string]: unknown
}

export interface ChannelMetaEntry {
  id: string
  label: string
  detailLabel: string
  systemImage?: string
}

export interface ChannelsStatusResult {
  ts: number
  channelOrder: string[]
  channelLabels: Record<string, string>
  channelDetailLabels?: Record<string, string>
  channelSystemImages?: Record<string, string>
  channelMeta?: ChannelMetaEntry[]
  channels: Record<string, unknown>
  channelAccounts: Record<string, ChannelAccountSnapshot[]>
  channelDefaultAccountId: Record<string, string>
}

export async function getChannelsStatus(probe = false): Promise<ChannelsStatusResult> {
  const params = probe ? '?probe=true' : ''
  return fetchJSON<ChannelsStatusResult>(`/api/openclaw/channels/status${params}`)
}

export async function getConfiguredChannels(): Promise<{ success: boolean; channels: string[] }> {
  return fetchJSON<{ success: boolean; channels: string[] }>('/api/openclaw/channels/configured')
}

export async function getChannelConfig(channelType: string): Promise<{ config: Record<string, unknown> | null }> {
  return fetchJSON<{ config: Record<string, unknown> | null }>(
    `/api/openclaw/channels/${encodeURIComponent(channelType)}/config`,
  )
}

export async function saveChannelConfig(
  channelType: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(
    `/api/openclaw/channels/${encodeURIComponent(channelType)}/config`,
    {
      method: 'PUT',
      body: JSON.stringify(config),
    },
  )
}

export async function deleteChannelConfig(channelType: string): Promise<{ ok: boolean }> {
  return fetchJSON<{ ok: boolean }>(
    `/api/openclaw/channels/${encodeURIComponent(channelType)}/config`,
    { method: 'DELETE' },
  )
}

export async function logoutChannel(
  channelType: string,
  accountId?: string,
): Promise<Record<string, unknown>> {
  return fetchJSON<Record<string, unknown>>(
    `/api/openclaw/channels/${encodeURIComponent(channelType)}/logout`,
    {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    },
  )
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  content: string
  link: string | null
  is_read: boolean
  created_at: string
}

export async function listNotifications(unreadOnly = false): Promise<Notification[]> {
  return fetchJSON<Notification[]>(`/api/notifications?unread_only=${unreadOnly}`)
}

export async function getUnreadCount(): Promise<{ count: number }> {
  return fetchJSON<{ count: number }>('/api/notifications/unread-count')
}

export async function markNotificationsAsRead(ids: string[]): Promise<void> {
  await fetchJSON('/api/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ notification_ids: ids }),
  })
}

export async function markAllNotificationsAsRead(): Promise<void> {
  await fetchJSON('/api/notifications/read-all', { method: 'POST' })
}
