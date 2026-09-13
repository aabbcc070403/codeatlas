'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FileArchive, Loader2, Upload, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'

interface ImportResult {
  snapshot: { id: string; fileCount: number; skippedCount: number; contentHash: string }
  skipped: Array<{ path: string; reason: string }>
  structure: {
    languageCounts: Record<string, number>
    dependencyFiles: Array<{ path: string; declared: string[] }>
    lockFiles: string[]
    importEdgeCount: number
    unresolvedImportCount: number
  }
}

export function UploadSnapshot({ projectId }: { projectId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)

  async function onFileSelected(file: File) {
    setUploading(true)
    setError(null)
    setResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/projects/${projectId}/snapshots`, {
        method: 'POST',
        body: form,
      })
      if (res.ok) {
        setResult((await res.json()) as ImportResult)
        router.refresh()
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        setError(body?.error?.message ?? `导入失败（${res.status}）`)
      }
    } catch {
      setError('网络错误')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileArchive className="h-4 w-4 text-primary" />
          导入代码快照
        </CardTitle>
        <CardDescription>
          上传项目 ZIP（≤20MiB，解压 ≤80MiB，≤2000 个文件）。导入时自动忽略
          node_modules/dist/.git 等，疑似密钥将等长遮盖后再存储。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFileSelected(f)
            }}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? '导入中…' : '选择 ZIP 文件'}
          </Button>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            默认仅本地静态分析；勾选云端 AI 后才会发送脱敏代码片段
          </span>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {result && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              导入完成：{result.snapshot.fileCount} 个文件
              {result.snapshot.skippedCount > 0 && (
                <>
                  ，{result.snapshot.skippedCount} 个跳过/忽略
                </>
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(result.structure.languageCounts).map(([lang, n]) => (
                <Badge key={lang} variant="secondary">
                  {lang} × {n}
                </Badge>
              ))}
              <Badge variant="outline">
                相对导入 {result.structure.importEdgeCount} 条
              </Badge>
              {result.structure.unresolvedImportCount > 0 && (
                <Badge variant="warning">未解析导入 {result.structure.unresolvedImportCount} 条</Badge>
              )}
              {result.structure.lockFiles.length > 0 ? (
                <Badge variant="muted">锁文件存在</Badge>
              ) : (
                <Badge variant="muted">无锁文件</Badge>
              )}
            </div>
            {result.skipped.length > 0 && (
              <div className="mt-2">
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSkipped(!showSkipped)}
                >
                  {showSkipped ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  查看忽略明细（{result.skipped.length}）
                </button>
                {showSkipped && (
                  <ul className="mt-1 max-h-40 overflow-auto rounded border bg-card p-2 text-xs">
                    {result.skipped.map((s) => (
                      <li key={s.path} className="flex gap-2 py-0.5">
                        <span className="text-muted-foreground">{s.path}</span>
                        <span className="ml-auto shrink-0">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
