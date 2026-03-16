import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'

type Theme = 'light' | 'dark' | 'system'

interface ThemeToggleProps {
  variant?: 'simple' | 'full'
  className?: string
}

export function ThemeToggle({ variant = 'simple', className = '' }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme()

  if (variant === 'simple') {
    return (
      <button
        onClick={() => setTheme(resolvedTheme === 'light' ? 'dark' : 'light')}
        className={[
          'p-2 rounded-lg transition-all duration-200',
          'text-text-secondary hover:text-text-primary',
          'hover:bg-surface/50',
          className,
        ].join(' ')}
        title={resolvedTheme === 'light' ? '切换到暗色模式' : '切换到亮色模式'}
      >
        {resolvedTheme === 'light' ? (
          <Moon size={18} />
        ) : (
          <Sun size={18} />
        )}
      </button>
    )
  }

  // Full variant with all three options
  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
    { value: 'system', icon: Monitor, label: '跟随系统' },
  ]

  return (
    <div className={['flex items-center gap-1 p-1 rounded-lg bg-surface/50', className].join(' ')}>
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={[
            'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200',
            theme === value
              ? 'bg-elevated text-primary shadow-sm'
              : 'text-secondary hover:text-primary hover:bg-surface',
          ].join(' ')}
          title={label}
        >
          <Icon size={16} />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  )
}
