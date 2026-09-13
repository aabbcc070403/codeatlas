'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, Search } from 'lucide-react'

interface SearchChunk {
  chunkId: string
  title: string
  heading: string
  text: string
  sourceUrl: string | null
  version: number
  via: string[]
  rrfScore: number
}

interface SearchResponse {
  search: { chunks: SearchChunk[]; mode: string; note: string } | null
}

export function KnowledgeSearch({ projectId }: { projectId?: string | null }) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SearchResponse['search']>(null)

  async function onSearch() {
    if (!query.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const url = new URL('/api/knowledge', window.location.origin)
      url.searchParams.set('q', query.trim())
      if (projectId) url.searchParams.set('projectId', projectId)
      const res = await fetch(url.toString())
      if (res.ok) {
        const body = (await res.json()) as SearchResponse
        setResult(body.search)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-4 w-4 text-primary" />
          检索测试
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSearch()
            }}
            placeholder="例如：innerHTML 注入怎么防 / 列表 key / postMessage"
            aria-label="检索关键词"
          />
          <Button onClick={onSearch} disabled={loading || !query.trim()}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            检索
          </Button>
        </div>
        {result && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{result.note}</p>
            {result.chunks.length === 0 && (
              <p className="text-sm text-muted-foreground">无命中规范（不会编造结果）</p>
            )}
            {result.chunks.map((chunk) => (
              <div key={chunk.chunkId} className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{chunk.title}</span>
                  {chunk.via.includes('vector') && <Badge variant="ai">向量</Badge>}
                  {chunk.via.includes('lexical') && <Badge variant="secondary">词法</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    RRF {chunk.rrfScore} · v{chunk.version}
                  </span>
                </div>
                {chunk.heading && (
                  <p className="mt-1 text-xs text-muted-foreground">#{chunk.heading}</p>
                )}
                <p className="mt-1 line-clamp-3 text-muted-foreground">{chunk.text}</p>
                {chunk.sourceUrl && (
                  <a
                    href={chunk.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate text-xs text-primary hover:underline"
                  >
                    来源：{chunk.sourceUrl}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ProjectDocUpload({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onFile(file: File) {
    if (!projectId) return
    setUploading(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/projects/${projectId}/documents`, {
        method: 'POST',
        body: form,
      })
      const body = (await res.json().catch(() => null)) as
        | { document?: { title: string; chunkCount: number; indexStatus: string }; error?: { message: string } }
        | null
      if (res.ok && body?.document) {
        const d = body.document
        setMessage(
          `已导入「${d.title}」（${d.chunkCount} 块；索引状态：${
            d.indexStatus === 'lexical_only' ? '仅词法检索（未配置嵌入模型）' : d.indexStatus
          }）`,
        )
      } else {
        setMessage(body?.error?.message ?? `导入失败（${res.status}）`)
      }
    } catch {
      setMessage('网络错误')
    } finally {
      setUploading(false)
    }
  }

  if (projects.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">导入项目规范（Markdown）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            aria-label="选择项目"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="file"
              accept=".md,.markdown"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onFile(f)
                e.target.value = ''
              }}
            />
            <span
              className={`inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-card px-4 py-2 text-sm font-medium transition-colors hover:bg-accent ${
                uploading ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
              选择 .md 文件
            </span>
          </label>
          <span className="text-xs text-muted-foreground">每项目最多 10 个文件，总计 1MiB</span>
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>
  )
}

export function IndexStatusNotice({ providerReady }: { providerReady: boolean }) {
  const [show, setShow] = useState(false)
  useEffect(() => setShow(true), [])
  if (!show || providerReady) return null
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
      当前未配置真实嵌入模型：检索为词法（字符二元组）模式，规范引用不经过向量语义匹配。
      配置 AI_EMBEDDING_MODEL 后重建索引可启用混合检索。
    </p>
  )
}
