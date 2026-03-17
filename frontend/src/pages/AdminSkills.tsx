import { useState, useEffect } from 'react'
import {
  adminListCuratedSkills, adminUploadCuratedSkill, adminUpdateCuratedSkill,
  adminDeleteCuratedSkill, adminListSubmissions, adminApproveSubmission,
  adminRejectSubmission, adminGetSubmissionContent, adminListPlatformSkills,
  adminUpdatePlatformSkillVisibility, adminSyncPlatformSkills,
} from '../lib/api'
import type { CuratedSkill, SkillSubmission, AdminPlatformSkill } from '../lib/api'
import {
  Loader2, Plus, Trash2, Star, Check, X, Upload,
  ChevronUp, Edit2, Eye, EyeOff, RefreshCw, Package,
  ChevronDown, FileText, Bot, ExternalLink,
} from 'lucide-react'

type AdminTab = 'curated' | 'platform' | 'submissions'

export default function AdminSkills() {
  const [tab, setTab] = useState<AdminTab>('curated')

  // Curated skills
  const [skills, setSkills] = useState<CuratedSkill[]>([])
  const [loading, setLoading] = useState(true)

  // Platform skills
  const [platformSkills, setPlatformSkills] = useState<AdminPlatformSkill[]>([])
  const [loadingPlatform, setLoadingPlatform] = useState(true)
  const [syncingPlatform, setSyncingPlatform] = useState(false)
  const [togglingSkill, setTogglingSkill] = useState<string | null>(null)

  // Submissions
  const [submissions, setSubmissions] = useState<SkillSubmission[]>([])
  const [loadingSubs, setLoadingSubs] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('pending')

  // Add form
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addDesc, setAddDesc] = useState('')
  const [addAuthor, setAddAuthor] = useState('')
  const [addCategory, setAddCategory] = useState('general')
  const [addFeatured, setAddFeatured] = useState(false)
  const [addFile, setAddFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)

  // Edit
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFields, setEditFields] = useState<Record<string, string | boolean>>({})
  const [saving, setSaving] = useState(false)

  // Review
  const [reviewNotes, setReviewNotes] = useState('')
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [expandedSub, setExpandedSub] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<Record<string, string>>({})
  const [loadingContent, setLoadingContent] = useState<string | null>(null)

  const refreshSkills = () => {
    adminListCuratedSkills().then(setSkills).catch(() => setSkills([])).finally(() => setLoading(false))
  }

  const refreshPlatform = () => {
    adminListPlatformSkills()
      .then(skills => {
        setPlatformSkills(skills)
      })
      .catch(() => setPlatformSkills([]))
      .finally(() => setLoadingPlatform(false))
  }

  const refreshSubmissions = () => {
    adminListSubmissions(statusFilter || undefined)
      .then(setSubmissions)
      .catch(() => setSubmissions([]))
      .finally(() => setLoadingSubs(false))
  }

  useEffect(() => { refreshSkills() }, [])
  useEffect(() => { refreshPlatform() }, [])
  useEffect(() => { refreshSubmissions() }, [statusFilter])

  const handleSyncPlatform = async () => {
    setSyncingPlatform(true)
    try {
      await adminSyncPlatformSkills()
      refreshPlatform()
    } catch {
      // ignore
    } finally {
      setSyncingPlatform(false)
    }
  }

  const handleToggleVisibility = async (skillName: string, currentVisible: boolean) => {
    setTogglingSkill(skillName)
    try {
      await adminUpdatePlatformSkillVisibility(skillName, !currentVisible)
      setPlatformSkills(prev => prev.map(s =>
        s.skill_name === skillName ? { ...s, is_visible: !currentVisible } : s
      ))
    } catch {
      // ignore
    } finally {
      setTogglingSkill(null)
    }
  }

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addName.trim() || !addFile || uploading) return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('name', addName.trim())
      formData.append('description', addDesc.trim())
      formData.append('author', addAuthor.trim())
      formData.append('category', addCategory)
      formData.append('is_featured', String(addFeatured))
      formData.append('file', addFile)
      await adminUploadCuratedSkill(formData)
      setShowAdd(false)
      setAddName('')
      setAddDesc('')
      setAddAuthor('')
      setAddCategory('general')
      setAddFeatured(false)
      setAddFile(null)
      refreshSkills()
    } catch {
      // ignore
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此精选技能？')) return
    try {
      await adminDeleteCuratedSkill(id)
      setSkills(prev => prev.filter(s => s.id !== id))
    } catch {
      // ignore
    }
  }

  const handleSaveEdit = async (id: string) => {
    setSaving(true)
    try {
      await adminUpdateCuratedSkill(id, editFields as any)
      setEditingId(null)
      setEditFields({})
      refreshSkills()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async (id: string) => {
    setReviewing(id)
    try {
      await adminApproveSubmission(id, reviewNotes || undefined)
      setReviewNotes('')
      refreshSubmissions()
      refreshSkills()
    } catch {
      // ignore
    } finally {
      setReviewing(null)
    }
  }

  const handleLoadContent = async (id: string) => {
    if (skillContent[id] || loadingContent === id) return
    setLoadingContent(id)
    try {
      const res = await adminGetSubmissionContent(id)
      setSkillContent(prev => ({ ...prev, [id]: res.content }))
    } catch {
      setSkillContent(prev => ({ ...prev, [id]: '(无法获取技能内容)' }))
    } finally {
      setLoadingContent(null)
    }
  }

  const handleReject = async (id: string) => {
    setReviewing(id)
    try {
      await adminRejectSubmission(id, reviewNotes || undefined)
      setReviewNotes('')
      refreshSubmissions()
    } catch {
      // ignore
    } finally {
      setReviewing(null)
    }
  }

  const tabs: { key: AdminTab; label: string }[] = [
    { key: 'curated', label: '精选技能' },
    { key: 'platform', label: '平台技能' },
    { key: 'submissions', label: '待审核' },
  ]

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">技能管理</h1>
        <p className="mt-1 text-sm text-text-secondary">管理精选技能、平台技能可见性和用户提交审核</p>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 rounded-lg bg-bg-surface p-1 border border-border-default">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-accent-blue text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-base'
            }`}
          >
            {t.label}
            {t.key === 'submissions' && submissions.filter(s => s.status === 'pending').length > 0 && (
              <span className="ml-1.5 rounded-full bg-accent-red px-1.5 text-xs text-white">
                {submissions.filter(s => s.status === 'pending').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ===== Curated Tab ===== */}
      {tab === 'curated' && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm text-text-secondary">{skills.length} 个精选技能</span>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-1.5 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90"
            >
              {showAdd ? <ChevronUp size={14} /> : <Plus size={14} />}
              {showAdd ? '收起' : '添加技能'}
            </button>
          </div>

          {/* Add form */}
          {showAdd && (
            <form onSubmit={handleUpload} className="mb-6 rounded-xl border border-border-default bg-bg-surface p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">技能名称 *</label>
                  <input
                    type="text"
                    value={addName}
                    onChange={e => setAddName(e.target.value)}
                    className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">作者</label>
                  <input
                    type="text"
                    value={addAuthor}
                    onChange={e => setAddAuthor(e.target.value)}
                    className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">描述</label>
                <textarea
                  value={addDesc}
                  onChange={e => setAddDesc(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">分类</label>
                  <input
                    type="text"
                    value={addCategory}
                    onChange={e => setAddCategory(e.target.value)}
                    className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-blue"
                  />
                </div>
                <div className="flex items-end gap-2 pb-1">
                  <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addFeatured}
                      onChange={e => setAddFeatured(e.target.checked)}
                      className="rounded"
                    />
                    推荐
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">技能文件 (zip) *</label>
                <input
                  type="file"
                  accept=".zip"
                  onChange={e => setAddFile(e.target.files?.[0] || null)}
                  className="text-sm text-text-primary"
                />
              </div>
              <button
                type="submit"
                disabled={!addName.trim() || !addFile || uploading}
                className="flex items-center gap-2 rounded-lg bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/90 disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                上传并创建
              </button>
            </form>
          )}

          {/* Skills list */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-accent-blue" />
            </div>
          ) : skills.length === 0 ? (
            <div className="rounded-xl border border-border-default bg-bg-surface p-8 text-center text-sm text-text-secondary">
              暂无精选技能
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map(skill => {
                const isEditing = editingId === skill.id
                return (
                  <div key={skill.id} className="rounded-xl border border-border-default bg-bg-surface px-5 py-4">
                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          defaultValue={skill.description}
                          onChange={e => setEditFields(prev => ({ ...prev, description: e.target.value }))}
                          placeholder="描述"
                          className="w-full rounded border border-border-default bg-bg-base px-2 py-1 text-sm text-text-primary outline-none"
                        />
                        <div className="flex gap-2">
                          <input
                            type="text"
                            defaultValue={skill.author}
                            onChange={e => setEditFields(prev => ({ ...prev, author: e.target.value }))}
                            placeholder="作者"
                            className="flex-1 rounded border border-border-default bg-bg-base px-2 py-1 text-sm text-text-primary outline-none"
                          />
                          <input
                            type="text"
                            defaultValue={skill.category}
                            onChange={e => setEditFields(prev => ({ ...prev, category: e.target.value }))}
                            placeholder="分类"
                            className="flex-1 rounded border border-border-default bg-bg-base px-2 py-1 text-sm text-text-primary outline-none"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSaveEdit(skill.id)}
                            disabled={saving}
                            className="flex items-center gap-1 rounded bg-accent-green/20 px-3 py-1 text-xs text-accent-green hover:bg-accent-green/30"
                          >
                            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} 保存
                          </button>
                          <button
                            onClick={() => { setEditingId(null); setEditFields({}) }}
                            className="flex items-center gap-1 rounded bg-border-default/30 px-3 py-1 text-xs text-text-secondary hover:bg-border-default/50"
                          >
                            <X size={12} /> 取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {skill.is_featured && <Star size={14} className="text-accent-yellow shrink-0" />}
                            <span className="text-sm font-medium text-text-primary">{skill.name}</span>
                            <span className="rounded bg-bg-base px-1.5 py-0.5 text-xs text-text-secondary">{skill.category}</span>
                            <span className="text-xs text-text-secondary">{skill.install_count} 次安装</span>
                          </div>
                          <p className="mt-0.5 text-xs text-text-secondary truncate">{skill.description}</p>
                        </div>
                        <div className="ml-4 flex shrink-0 gap-1.5">
                          <button
                            onClick={() => { setEditingId(skill.id); setEditFields({}) }}
                            className="rounded p-1.5 text-text-secondary hover:bg-bg-base hover:text-text-primary"
                            title="编辑"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDelete(skill.id)}
                            className="rounded p-1.5 text-text-secondary hover:bg-accent-red/10 hover:text-accent-red"
                            title="删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ===== Platform Tab ===== */}
      {tab === 'platform' && (
        <div>
          <div className="mb-4 flex items-center justify-between rounded-lg border border-accent-blue/20 bg-accent-blue/5 px-4 py-3">
            <p className="text-sm text-text-primary">
              <Package size={14} className="inline mr-1.5 text-accent-blue" />
              平台技能来自项目 skills/ 目录，管理员可以控制哪些技能对用户可见。
            </p>
            <button
              onClick={handleSyncPlatform}
              disabled={syncingPlatform}
              className="flex items-center gap-1.5 rounded-lg bg-accent-blue px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-blue/90 disabled:opacity-50"
            >
              {syncingPlatform ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              同步技能
            </button>
          </div>

          {loadingPlatform ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-accent-blue" />
            </div>
          ) : platformSkills.length === 0 ? (
            <div className="rounded-xl border border-border-default bg-bg-surface p-8 text-center text-sm text-text-secondary">
              暂无平台技能，请先将技能放入项目 skills/ 目录
            </div>
          ) : (
            <div className="space-y-2">
              {platformSkills.map(skill => {
                const isToggling = togglingSkill === skill.skill_name
                return (
                  <div
                    key={skill.skill_name}
                    className="flex items-center justify-between rounded-lg border border-border-default bg-bg-surface px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded bg-accent-blue/10">
                        <Package size={16} className="text-accent-blue" />
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-text-primary">{skill.skill_name}</h3>
                        <p className="text-xs text-text-secondary">{skill.description || '暂无描述'}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleToggleVisibility(skill.skill_name, skill.is_visible)}
                      disabled={isToggling}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        skill.is_visible
                          ? 'bg-accent-green/10 text-accent-green hover:bg-accent-green/20'
                          : 'bg-bg-base text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {isToggling ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : skill.is_visible ? (
                        <Eye size={12} />
                      ) : (
                        <EyeOff size={12} />
                      )}
                      {skill.is_visible ? '可见' : '隐藏'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ===== Submissions Tab ===== */}
      {tab === 'submissions' && (
        <div>
          <div className="mb-4 flex gap-2">
            {['pending', 'approved', 'rejected', ''].map(s => (
              <button
                key={s || 'all'}
                onClick={() => { setStatusFilter(s); setLoadingSubs(true) }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-accent-blue text-white'
                    : 'bg-bg-surface text-text-secondary hover:text-text-primary border border-border-default'
                }`}
              >
                {s === 'pending' ? '待审核' : s === 'approved' ? '已通过' : s === 'rejected' ? '已拒绝' : '全部'}
              </button>
            ))}
          </div>

          {loadingSubs ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-accent-blue" />
            </div>
          ) : submissions.length === 0 ? (
            <div className="rounded-xl border border-border-default bg-bg-surface p-8 text-center text-sm text-text-secondary">
              暂无提交记录
            </div>
          ) : (
            <div className="space-y-3">
              {submissions.map(sub => {
                const isExpanded = expandedSub === sub.id
                const aiReview = sub.ai_review_result ? (() => {
                  try { return JSON.parse(sub.ai_review_result) } catch { return null }
                })() : null

                return (
                  <div key={sub.id} className="rounded-xl border border-border-default bg-bg-surface overflow-hidden">
                    {/* Header row */}
                    <div
                      className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-bg-base/50 transition-colors"
                      onClick={() => {
                        const next = isExpanded ? null : sub.id
                        setExpandedSub(next)
                        if (next) handleLoadContent(next)
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-text-primary">{sub.skill_name}</span>
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                            sub.status === 'approved' ? 'bg-accent-green/10 text-accent-green' :
                            sub.status === 'rejected' ? 'bg-accent-red/10 text-accent-red' :
                            sub.status === 'ai_reviewed' ? 'bg-accent-blue/10 text-accent-blue' :
                            'bg-accent-yellow/10 text-accent-yellow'
                          }`}>
                            {sub.status === 'approved' ? '已通过' :
                             sub.status === 'rejected' ? '已拒绝' :
                             sub.status === 'ai_reviewed' ? 'AI已审' : '待审核'}
                          </span>
                          {sub.file_path && (
                            <span className="flex items-center gap-1 rounded bg-bg-base px-1.5 py-0.5 text-xs text-text-secondary">
                              <FileText size={10} /> 含文件
                            </span>
                          )}
                          {aiReview && (
                            <span className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                              aiReview.approved ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
                            }`}>
                              <Bot size={10} /> AI {aiReview.approved ? '推荐通过' : '建议拒绝'} {aiReview.score != null ? `(${aiReview.score})` : ''}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-xs text-text-secondary">
                          <span>提交者: {sub.user_id.slice(0, 8)}...</span>
                          <span>{new Date(sub.created_at).toLocaleString()}</span>
                          {sub.description && <span className="truncate max-w-xs">{sub.description}</span>}
                        </div>
                      </div>
                      {isExpanded ? <ChevronUp size={16} className="text-text-secondary shrink-0" /> : <ChevronDown size={16} className="text-text-secondary shrink-0" />}
                    </div>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="border-t border-border-default px-5 py-4 space-y-4">

                        {/* Source URL */}
                        {sub.source_url && (
                          <div>
                            <p className="text-xs font-medium text-text-secondary mb-1">来源链接</p>
                            <a href={sub.source_url} target="_blank" rel="noreferrer"
                              className="flex items-center gap-1 text-xs text-accent-blue hover:underline">
                              <ExternalLink size={12} /> {sub.source_url}
                            </a>
                          </div>
                        )}

                        {/* AI Review Result */}
                        {aiReview && (
                          <div>
                            <p className="text-xs font-medium text-text-secondary mb-1.5">AI 审核结果</p>
                            <div className={`rounded-lg border px-4 py-3 text-xs space-y-2 ${
                              aiReview.approved ? 'border-accent-green/30 bg-accent-green/5' : 'border-accent-red/30 bg-accent-red/5'
                            }`}>
                              {aiReview.summary && <p className="text-text-primary">{aiReview.summary}</p>}
                              {aiReview.issues?.length > 0 && (
                                <div className="space-y-1">
                                  {aiReview.issues.map((issue: any, i: number) => (
                                    <div key={i} className="flex gap-2">
                                      <span className={`shrink-0 font-medium ${
                                        issue.severity === 'critical' ? 'text-accent-red' :
                                        issue.severity === 'major' ? 'text-accent-yellow' : 'text-text-secondary'
                                      }`}>[{issue.severity}]</span>
                                      <span className="text-text-secondary">{issue.message}{issue.suggestion ? ` — ${issue.suggestion}` : ''}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* SKILL.md content */}
                        <div>
                          <p className="text-xs font-medium text-text-secondary mb-1.5">技能内容 (SKILL.md)</p>
                          {loadingContent === sub.id ? (
                            <div className="flex items-center gap-2 text-xs text-text-secondary">
                              <Loader2 size={12} className="animate-spin" /> 加载中...
                            </div>
                          ) : skillContent[sub.id] ? (
                            <pre className="rounded-lg bg-bg-base border border-border-default p-3 text-xs text-text-primary overflow-auto max-h-64 whitespace-pre-wrap font-mono">
                              {skillContent[sub.id]}
                            </pre>
                          ) : (
                            <p className="text-xs text-text-secondary">无可用内容</p>
                          )}
                        </div>

                        {/* Admin notes */}
                        {sub.admin_notes && (
                          <div>
                            <p className="text-xs font-medium text-text-secondary mb-1">管理员备注</p>
                            <p className="text-xs text-text-primary">{sub.admin_notes}</p>
                          </div>
                        )}

                        {/* Actions */}
                        {sub.status !== 'approved' && sub.status !== 'rejected' && (
                          <div className="flex items-center gap-2 pt-1 border-t border-border-default">
                            <input
                              type="text"
                              placeholder="审核备注（可选）"
                              value={reviewing === sub.id ? reviewNotes : ''}
                              onChange={e => { setReviewing(sub.id); setReviewNotes(e.target.value) }}
                              onFocus={() => setReviewing(sub.id)}
                              className="flex-1 rounded border border-border-default bg-bg-base px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent-blue"
                            />
                            <button
                              onClick={() => handleApprove(sub.id)}
                              className="flex items-center gap-1 rounded bg-accent-green/20 px-3 py-1.5 text-xs font-medium text-accent-green hover:bg-accent-green/30"
                            >
                              <Check size={12} /> 通过
                            </button>
                            <button
                              onClick={() => handleReject(sub.id)}
                              className="flex items-center gap-1 rounded bg-accent-red/20 px-3 py-1.5 text-xs font-medium text-accent-red hover:bg-accent-red/30"
                            >
                              <X size={12} /> 拒绝
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
