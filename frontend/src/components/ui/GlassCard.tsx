/**
 * 玻璃拟态卡片组件
 * 使用新主题系统
 */

import type { ReactNode } from 'react'

interface GlassCardProps {
  children: ReactNode
  className?: string
  variant?: 'default' | 'elevated' | 'glowing'
  header?: ReactNode
  footer?: ReactNode
}

export function GlassCard({
  children,
  className = '',
  variant = 'default',
  header,
  footer,
}: GlassCardProps) {
  const baseClasses = 'rounded-xl border backdrop-blur-sm transition-all duration-200'

  const variantClasses = {
    default: [
      'bg-white/[0.03]',
      'shadow-lg shadow-black/20',
    ].join(' '),

    elevated: [
      'bg-white/[0.05]',
      'shadow-xl shadow-black/30',
      'hover:shadow-2xl hover:shadow-black/40',
    ].join(' '),

    glowing: [
      'bg-white/[0.03]',
      'shadow-lg shadow-black/20',
      'hover:shadow-xl hover:shadow-accent-blue-glow/20',
      'relative overflow-hidden',
    ].join(' '),
  }

  return (
    <div className={`${baseClasses} ${variantClasses[variant]} ${className}`}>
      {/* 顶部微光效果 */}
      {variant === 'glowing' && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent-blue/50 to-transparent" />
      )}

      {header && (
        <div className="px-6 py-4">
          {header}
        </div>
      )}

      <div className="p-6">{children}</div>

      {footer && (
        <div className="px-6 py-4 bg-black/10">
          {footer}
        </div>
      )}
    </div>
  )
}

/**
 * 渐变按钮
 */
interface GradientButtonProps {
  children: ReactNode
  variant?: 'primary' | 'success' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
  disabled?: boolean
  className?: string
}

export function GradientButton({
  children,
  variant = 'primary',
  size = 'md',
  onClick,
  disabled,
  className = '',
}: GradientButtonProps) {
  const baseClasses = [
    'relative inline-flex items-center justify-center',
    'font-medium rounded-lg',
    'transition-all duration-200',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    'active:scale-[0.98]',
  ].join(' ')

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  const variantClasses = {
    primary: [
      'bg-accent-blue text-white',
      'hover:bg-accent-blue-light',
      'shadow-lg shadow-accent-blue-glow/30',
      'hover:shadow-xl hover:shadow-accent-blue-glow/50',
    ].join(' '),

    success: [
      'bg-accent-green text-white',
      'hover:bg-accent-green-light',
      'shadow-lg shadow-accent-green-glow/30',
    ].join(' '),

    danger: [
      'bg-accent-red text-white',
      'hover:bg-accent-red-light',
      'shadow-lg shadow-accent-red-glow/30',
    ].join(' '),

    ghost: [
      'bg-white/[0.03] text-text-secondary',
      'hover:bg-white/[0.06] hover:text-text-primary',
    ].join(' '),
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * 状态徽章
 */
interface StatusBadgeProps {
  status: 'running' | 'stopped' | 'error' | 'pending' | 'success'
  text?: string
}

export function StatusBadge({ status, text }: StatusBadgeProps) {
  const configs = {
    running: {
      bg: 'bg-accent-green/10',
      border: 'border-accent-green/30',
      dot: 'bg-accent-green',
      text: 'text-accent-green-light',
      label: text || '运行中',
    },
    stopped: {
      bg: 'bg-text-muted/10',
      border: 'border-text-muted/30',
      dot: 'bg-text-muted',
      text: 'text-text-tertiary',
      label: text || '已停止',
    },
    error: {
      bg: 'bg-accent-red/10',
      border: 'border-accent-red/30',
      dot: 'bg-accent-red',
      text: 'text-accent-red-light',
      label: text || '错误',
    },
    pending: {
      bg: 'bg-accent-yellow/10',
      border: 'border-accent-yellow/30',
      dot: 'bg-accent-yellow animate-pulse',
      text: 'text-accent-yellow-light',
      label: text || '等待中',
    },
    success: {
      bg: 'bg-accent-blue/10',
      border: 'border-accent-blue/30',
      dot: 'bg-accent-blue',
      text: 'text-accent-blue-light',
      label: text || '成功',
    },
  }

  const config = configs[status]

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.bg} ${config.border} ${config.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  )
}

/**
 * 渐变标题
 */
export function GradientTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <h1
      className={`text-2xl font-bold bg-gradient-to-r from-text-primary via-accent-blue-light to-accent-purple-light bg-clip-text text-transparent ${className}`}
    >
      {children}
    </h1>
  )
}

/**
 * 玻璃输入框
 */
interface GlassInputProps {
  placeholder?: string
  value?: string
  onChange?: (value: string) => void
  icon?: ReactNode
  className?: string
}

export function GlassInput({ placeholder, value, onChange, icon, className = '' }: GlassInputProps) {
  return (
    <div className={`relative ${className}`}>
      {icon && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
          {icon}
        </div>
      )}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className={[
          'w-full px-4 py-2.5 rounded-lg',
          'bg-bg-elevated/50 border border-border-default',
          'text-text-primary placeholder:text-text-muted',
          'focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/30',
          'transition-all duration-200',
          icon ? 'pl-10' : '',
        ].join(' ')}
      />
    </div>
  )
}
