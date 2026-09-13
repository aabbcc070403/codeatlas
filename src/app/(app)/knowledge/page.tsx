import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { aiProviderStatus } from '@/server/env'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  KnowledgeSearch,
  ProjectDocUpload,
  IndexStatusNotice,
} from '@/components/knowledge/knowledge-client'
import { BookOpen, ExternalLink } from 'lucide-react'

export const dynamic = 'force-dynamic'

const CATEGORY_LABEL: Record<string, string> = {
  security: '安全',
  correctness: '正确性',
  performance: '性能',
  maintainability: '可维护性',
}

interface BuiltinDoc {
  id: string
  builtin_key: string
  title: string
  category: string
  version: number
  source_url: string | null
  index_status: string
  chunk_count: number
}

export default async function KnowledgePage() {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const tokenHash = createHash('sha256').update(token ?? '').digest('hex')
  const sql = getDb()
  const sessionRows = await sql`select id from sessions
    where token_hash = ${tokenHash} and expires_at > now() limit 1`
  const sessionId = (sessionRows[0] as { id: string } | undefined)?.id
  if (!sessionId) redirect('/login')

  const projects = await sql`select id, name from projects
    where session_id = ${sessionId} order by created_at desc limit 20`
  const builtin = (await sql`
    select d.id, d.builtin_key, d.title, d.category, d.version, d.source_url, d.index_status,
      (select count(*)::int from chunks c where c.document_id = d.id) as chunk_count
    from documents d where d.is_builtin = true order by d.builtin_key asc`) as unknown as BuiltinDoc[]

  const ai = aiProviderStatus()
  const byCategory = new Map<string, BuiltinDoc[]>()
  for (const doc of builtin) {
    byCategory.set(doc.category, [...(byCategory.get(doc.category) ?? []), doc])
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BookOpen className="h-6 w-6 text-primary" />
          规范知识库
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {builtin.length} 条预置 Web 开发规范（原创摘要 + 官方来源），检索结果会作为 AI 审查的规范引用来源。
        </p>
      </div>

      <div className="mb-6">
        <IndexStatusNotice providerReady={ai.embeddingReady} />
      </div>

      <div className="mb-6">
        <KnowledgeSearch />
      </div>

      <div className="mb-6">
        <ProjectDocUpload projects={projects as unknown as Array<{ id: string; name: string }>} />
      </div>

      {[...byCategory.entries()].map(([category, docs]) => (
        <section key={category} className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {CATEGORY_LABEL[category] ?? category}（{docs.length}）
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {docs.map((doc) => (
              <Card key={doc.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{doc.builtin_key}</span>
                    {doc.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">v{doc.version}</Badge>
                  <Badge variant="outline">{doc.chunk_count} 块</Badge>
                  <Badge variant={doc.index_status === 'ready' ? 'success' : 'muted'}>
                    {doc.index_status === 'ready' ? '混合索引' : '仅词法'}
                  </Badge>
                  {doc.source_url && (
                    <a
                      href={doc.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto flex items-center gap-0.5 text-primary hover:underline"
                    >
                      来源 <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
