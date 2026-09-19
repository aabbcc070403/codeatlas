import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { aiProviderStatus } from '@/server/env'
import { Compass } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DesktopNav, MobileNav } from '@/components/app-nav'

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
          <Link href="/projects" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold">
            <Compass className="h-5 w-5 text-primary" />
            <span>CodeAtlas 码鉴</span>
          </Link>
          <DesktopNav />
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <Badge className="block min-w-0 max-w-[100px] shrink truncate sm:max-w-[220px]" variant={ai.chatReady ? 'ai' : 'muted'} title={
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
            <MobileNav />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
