'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, Trash2 } from 'lucide-react'

export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDelete() {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (res.status === 204) {
        window.location.href = '/projects'
        return
      }
      if (res.status === 202) {
        // 有活动任务：等待清理服务完成（轮询到项目 404）
        setDeleting(false)
        setWaiting(true)
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const check = await fetch(`/api/projects/${projectId}`).catch(() => null)
          if (check === null || check.status === 404) {
            window.location.href = '/projects'
            return
          }
        }
        setWaiting(false)
        setError('删除仍在进行（活动任务退出中），稍后项目会自动从列表消失')
        return
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      setError(body?.error?.message ?? '删除失败')
    } catch {
      setError('网络错误')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" />
        删除项目
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目「{projectName}」？</DialogTitle>
            <DialogDescription>
              将级联删除该项目的全部快照、扫描结果、问题、补丁与规范文档，且不可恢复。
              进行中的扫描任务会被请求取消。
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting || waiting}>
              取消
            </Button>
            <Button variant="destructive" onClick={onDelete} disabled={deleting || waiting}>
              {(deleting || waiting) && <Loader2 className="h-4 w-4 animate-spin" />}
              {waiting ? '等待活动任务退出…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
