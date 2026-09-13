import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { aiProviderStatus } from '@/server/env'
import { Compass, FolderKanban, BookOpen, LineChart } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  let role: 'demo' | 'admin' | null = null
  if (token) {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const rows = await getDb()`select role from sessions
      where token_hash = ${tokenHash} and expires_at > now() limit 1`
    role = rows.length > 0 ? (rows[0] as { role: 'demo' | 'admin' }).role : null
  }
  if (!role) redirect('/login')

  const ai = aiProviderStatus()

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <Link href="/projects" className="flex items-center gap-2 font-semibold">
            <Compass className="h-5 w-5 text-primary" />
            <span>CodeAtlas 码鉴</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/projects"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <FolderKanban className="h-4 w-4" />
              项目
            </Link>
            <Link
              href="/knowledge"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <BookOpen className="h-4 w-4" />
              知识库
            </Link>
            <Link
              href="/evaluation"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <LineChart className="h-4 w-4" />
              评测
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant={ai.chatReady ? 'ai' : 'muted'} title={
              ai.chatReady
                ? `当前模型：${ai.chatModel}`
                : '当前使用 Mock provider，未接入真实大模型'
            }>
              {ai.chatReady ? `AI: ${ai.chatModel}` : 'AI: Mock'}
            </Badge>
            {/* 角色徽章在窄屏隐藏：390px 视口下避免头部溢出（移动端无横向滚动） */}
            {role === 'admin' && (
              <span className="hidden sm:inline-flex">
                <Badge variant="secondary">管理员</Badge>
              </span>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
