import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { toErrorResponse } from '@/server/api/http'
import { requireReadableScan, requireSession } from '@/server/auth/guard'
import { asJson } from '@/server/db/json'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/**
 * SSE：事件从 scan_events 持久化游标续传（Last-Event-ID），
 * 15 秒心跳；扫描到达终态并排空事件后 3 秒关闭。
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)
    const scanId = ref.scanId

    const url = new URL(req.url)
    let cursor = Number(req.headers.get('last-event-id') ?? url.searchParams.get('cursor') ?? 0)
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

    const encoder = new TextEncoder()
    let closed = false
    let timer: ReturnType<typeof setInterval> | null = null
    let terminalSince: number | null = null

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (text: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            closed = true
          }
        }
        const sendEvent = (eventId: number, eventType: string, payload: unknown) => {
          send(`id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        // 恢复提示：让客户端知道当前游标
        send(`event: connected\ndata: ${JSON.stringify({ cursor })}\n\n`)

        const poll = async (): Promise<void> => {
          if (closed) return
          try {
            const events = await sql`select id, event_type, payload_json from scan_events
              where scan_id = ${scanId} and id > ${cursor} order by id asc limit 200`
            for (const e of events as unknown as Array<{
              id: number
              event_type: string
              payload_json: unknown
            }>) {
              cursor = Number(e.id)
              sendEvent(Number(e.id), e.event_type, asJson<unknown>(e.payload_json))
            }
            if (events.length === 0) {
              const statusRows = await sql`select status from scans where id = ${scanId}`
              if (statusRows.length > 0) {
                const status = (statusRows[0] as { status: string }).status
                if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
                  if (terminalSince === null) terminalSince = Date.now()
                  else if (Date.now() - terminalSince > 3000) {
                    send('event: done\ndata: {}\n\n')
                    cleanup()
                  }
                }
              }
            }
          } catch (err) {
            send(`event: error\ndata: ${JSON.stringify({ message: '事件流轮询失败' })}\n\n`)
            void err
          }
        }

        let lastHeartbeat = Date.now()
        const interval = setInterval(() => {
          if (closed) return
          if (Date.now() - lastHeartbeat >= 15_000) {
            lastHeartbeat = Date.now()
            send(': ping\n\n')
          }
          void poll()
        }, 1500)
        timer = interval

        const cleanup = () => {
          if (closed) return
          closed = true
          if (timer !== null) clearInterval(timer)
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }

        req.signal.addEventListener('abort', () => {
          cleanup()
        })

        await poll()
      },
      cancel() {
        closed = true
        if (timer !== null) clearInterval(timer)
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
