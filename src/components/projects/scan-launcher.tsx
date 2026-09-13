'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Play } from 'lucide-react'
import { useEffect, useState as useReactState } from 'react'

/** 开始审查：本地静态阶段默认执行；云端 AI 需用户主动勾选确认 */
export function ScanLauncher({ snapshotId, hasScan }: { snapshotId: string; hasScan: boolean }) {
  const router = useRouter()
  const [enableCloudAI, setEnableCloudAI] = useReactState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [provider, setProvider] = useState<{ provider: string; ready: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.ai) setProvider({ provider: body.ai.provider, ready: body.ai.ready })
      })
      .catch(() => {})
  }, [])

  async function launch() {
    setLaunching(true)
    setError(null)
    try {
      const res = await fetch(`/api/snapshots/${snapshotId}/scans`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ enableCloudAI, mode: 'standard' }),
      })
      if (res.status === 202) {
        const body = (await res.json()) as { scan: { id: string } }
        router.push(`/scans/${body.scan.id}`)
        return
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      setError(body?.error?.message ?? `启动失败（${res.status}）`)
    } catch {
      setError('网络错误')
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={launch} disabled={launching}>
          {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {hasScan ? '再次扫描' : '开始审查'}
        </Button>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={enableCloudAI}
            onChange={(e) => setEnableCloudAI(e.target.checked)}
            className="h-4 w-4 accent-teal-700"
            disabled={provider ? provider.provider === 'mock' && !provider.ready : false}
          />
          启用云端 AI 审查
          {provider?.provider === 'mock' && (
            <Badge variant="muted" className="ml-1">
              当前为 Mock
            </Badge>
          )}
        </label>
        <span className="text-xs text-muted-foreground">
          未勾选时仅执行本地静态规则，不外发任何代码
        </span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
