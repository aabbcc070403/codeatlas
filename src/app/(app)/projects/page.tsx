import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CreateProjectForm } from '@/components/projects/create-project-form'
import { FolderGit2, FlaskConical } from 'lucide-react'
import { formatTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const tokenHash = createHash('sha256').update(token ?? '').digest('hex')
  const sql = getDb()
  const sessionRows = await sql`select id from sessions
    where token_hash = ${tokenHash} and expires_at > now() limit 1`
  const sessionId = (sessionRows[0] as { id: string } | undefined)?.id
  if (!sessionId) redirect('/login')

  const projects = await sql`
    select p.id, p.name, p.created_at,
      (select count(*)::int from snapshots s where s.project_id = p.id) as snapshot_count
    from projects p where p.session_id = ${sessionId}
    order by p.created_at desc limit 50`
  const presetProjects = await sql`
    select p.id, p.name, p.created_at,
      (select count(*)::int from snapshots s where s.project_id = p.id) as snapshot_count
    from projects p where p.is_preset = true order by p.created_at asc limit 10`

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">项目</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            导入 ZIP 快照，进行静态体检与 AI 审查；所有数据与会话隔离。
          </p>
        </div>
        <CreateProjectForm />
      </div>

      {presetProjects.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FlaskConical className="h-4 w-4" />
            预置示例（只读）
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {presetProjects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="transition-shadow hover:shadow-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FolderGit2 className="h-4 w-4 text-primary" />
                      {p.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">预置</Badge>
                      <span>{p.snapshot_count} 个快照</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">我的项目</h2>
        {projects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <FolderGit2 className="h-10 w-10 text-muted-foreground/40" />
              <p className="font-medium">还没有项目</p>
              <p className="text-sm text-muted-foreground">
                在上方输入名称创建第一个项目，然后上传代码 ZIP 快照。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="transition-shadow hover:shadow-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FolderGit2 className="h-4 w-4 text-primary" />
                      {p.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>{p.snapshot_count} 个快照</span>
                      <span>{formatTime(p.created_at as string)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
