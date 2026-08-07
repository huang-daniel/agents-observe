import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Small tag distinguishing a worktree/pipeline-launched session (e.g.
 * no-mistakes, or any future worktree launcher resolved via the
 * git-origin-walk path in project-resolver.ts) from a direct interactive
 * session. Renders nothing for 'direct' or null/undefined — the tag only
 * needs to call out the less-common pipeline case.
 */
export function OriginKindBadge({
  originKind,
  className,
}: {
  originKind?: 'pipeline' | 'direct' | null
  className?: string
}) {
  if (originKind !== 'pipeline') return null
  return (
    <span
      data-testid="origin-kind-badge"
      title="Launched by a worktree-based verification pipeline (e.g. no-mistakes), not run directly in this project's checkout"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium shrink-0',
        'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <GitBranch className="h-2.5 w-2.5" />
      Pipeline agent
    </span>
  )
}
