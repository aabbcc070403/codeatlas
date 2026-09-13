'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Compass, Loader2 } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessCode: code }),
      })
      if (res.ok) {
        router.push('/projects')
        router.refresh()
        return
      }
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null
      if (res.status === 429) {
        setError(body?.error?.message ?? '尝试次数过多，请稍后再试')
      } else {
        setError(body?.error?.message ?? '访问码不正确')
      }
    } catch {
      setError('网络错误，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <Compass className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">CodeAtlas 码鉴</CardTitle>
          <CardDescription>证据驱动的 AI 项目体检工作台</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              type="password"
              placeholder="输入演示访问码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              aria-label="访问码"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || !code}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? '验证中…' : '进入工作台'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              默认演示访问码：codeatlas-demo（管理员评测：codeatlas-admin）
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
