/**
 * 本地数据库服务：PGlite（嵌入式 Postgres）+ pgvector 扩展，通过自实现的
 * Postgres 线协议 socket 服务暴露给 web / worker / 测试。
 *
 * 不使用 @electric-sql/pglite-socket：其 QueryQueueManager 以「单个协议消息」为
 * 粒度跨连接排队，两个客户端的 Parse/Bind 交错时会互相覆盖共享的 unnamed prepared
 * statement（实测 2000 次并发查询 475 次报 bind message 参数数不匹配）。本实现以
 * 「完整查询批次」（Parse..Sync/Flush）为最小执行单元，杜绝交错；事务期间将队列
 * 钉在事务持有者上，断开时回滚（与 pglite-socket 行为一致）。
 *
 * 生产/Docker 部署使用 compose.yaml 中的 postgres+pgvector 容器替代本进程，
 * 应用代码统一通过 DATABASE_URL 访问，两种模式无差别。
 */
import net from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import fs from 'node:fs'
import path from 'node:path'

export interface DbServerHandle {
  host: string
  port: number
  url: string
  stop: () => Promise<void>
}

interface ClientState {
  socket: net.Socket
  closed: boolean
  /** 当前累积中的扩展协议批次（Parse/Bind/Describe/Execute/Close/Flush/Sync） */
  batch: Buffer[]
  /** 本客户端当前 unnamed statement 的独占替代名（null=尚无） */
  unnamedStmt: string | null
}

interface BatchJob {
  client: ClientState | null // null = 系统任务（如断连回滚）
  force: boolean // 事务期间也强制执行（回滚）
  data: Buffer
  resolve: () => void
  reject: (err: unknown) => void
}

const SSL_REQUEST_CODE = 80877103
const CANCEL_REQUEST_CODE = 80877102
const STARTUP_CODE = 196608
/** 扩展协议消息类型（组成一个查询批次） */
const EXTENDED_TYPES = new Set(['P', 'B', 'D', 'E', 'C', 'H', 'S'])

/** 构造简单查询（'Q'）协议消息 */
function queryMessage(sql: string): Buffer {
  const body = Buffer.from(sql, 'utf8')
  const head = Buffer.alloc(5)
  head[0] = 0x51 // 'Q'
  head.writeUInt32BE(body.length + 1 + 4, 1)
  return Buffer.concat([head, body, Buffer.from([0])])
}

/* ---------------- unnamed statement 重写（会话独占名） ----------------
 * postgres.js 等驱动对带参数查询分两批：Parse+Describe+Sync+Flush（等参数类型），
 * 再 Bind+Execute+Sync（不带 Parse，引用之前的 unnamed statement）。
 * 批次按到达顺序交错执行时，其他客户端的新 Parse 会覆盖共享的 unnamed
 * statement（实测：bind message supplies N parameters, but prepared statement ""
 * requires M）。与 pgbouncer 相同的解法：为每个客户端的 unnamed statement
 * 分配独占名，Bind/Describe/Close 同步重写。
 * named statement 不允许同名 Parse 覆盖（协议：already exists），因此每次
 * unnamed Parse 分配新名，旧名通过「系统批次」（client=null，响应丢弃）补发
 * Close —— 不进入客户端响应流，避免污染驱动的消息解析；断连时清理残留名。
 */

let stmtSeq = 0
function allocStmtName(): string {
  return `cs${process.pid}_${++stmtSeq}`
}

/** 消息内 cstring 的结尾 \0 下标（from 起） */
function cstringEnd(buf: Buffer, from: number): number {
  let i = from
  while (i < buf.length && buf[i] !== 0) i++
  return i
}

/** 重写 Parse：unnamed → 独占名 */
function rewriteParseUnnamed(msg: Buffer, newName: string): Buffer {
  const stmtEnd = cstringEnd(msg, 5)
  const rest = msg.subarray(stmtEnd) // \0 + query\0 + 参数类型
  const head = Buffer.alloc(5)
  head[0] = 0x50 // 'P'
  const body = Buffer.concat([Buffer.from(newName, 'utf8'), rest])
  head.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

/** Bind 的 statement 引用是否为 unnamed */
function bindStmtStart(msg: Buffer): number {
  return cstringEnd(msg, 5) + 1
}

function rewriteBindUnnamed(msg: Buffer, newName: string): Buffer {
  const stmtStart = bindStmtStart(msg)
  const stmtEnd = cstringEnd(msg, stmtStart)
  const before = msg.subarray(5, stmtStart) // portal\0
  const rest = msg.subarray(stmtEnd) // \0 + 参数等
  const head = Buffer.alloc(5)
  head[0] = 0x42 // 'B'
  const body = Buffer.concat([before, Buffer.from(newName, 'utf8'), rest])
  head.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

/** Describe('D')/Close('C')：type 字节在 offset 5，name 从 offset 6 起 */
function rewriteNamedRefUnnamed(msg: Buffer, newName: string): Buffer {
  const nameEnd = cstringEnd(msg, 6)
  const rest = msg.subarray(nameEnd) // \0（及 Close 后无内容）
  const head = Buffer.alloc(5)
  head[0] = msg[0]!
  const body = Buffer.concat([msg.subarray(5, 6), Buffer.from(newName, 'utf8'), rest])
  head.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

/** 构造 Close(statement) 消息 */
function closeStmtMessage(name: string): Buffer {
  const body = Buffer.concat([Buffer.from([0x53 /* 'S' */]), Buffer.from(name, 'utf8'), Buffer.from([0])])
  const head = Buffer.alloc(5)
  head[0] = 0x43 // 'C'
  head.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

function makeErrorResponse(message: string): Buffer {
  const fields = Buffer.from(
    `SERROR\0C58000\0M${message}\0\0`,
    'utf8',
  )
  const head = Buffer.alloc(5)
  head[0] = 0x45 // 'E'
  head.writeUInt32BE(fields.length + 4, 1)
  return Buffer.concat([head, fields])
}

export async function startDbServer(
  opts: { dataDir?: string; port?: number; maxConnections?: number } = {},
): Promise<DbServerHandle> {
  const dataDir = path.isAbsolute(opts.dataDir ?? '')
    ? (opts.dataDir as string)
    : path.resolve(process.cwd(), opts.dataDir ?? '.data/pglite')
  fs.mkdirSync(path.dirname(dataDir), { recursive: true })

  const db = await PGlite.create({
    dataDir,
    extensions: { vector },
  })

  const requestedPort = opts.port ?? 5433
  // 先探测端口是否被占用；被占用则报错，由调用方换端口
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port: requestedPort })
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
  if (inUse) {
    await db.close()
    throw new Error(
      `端口 ${requestedPort} 已被占用：如已有数据库服务在运行请直接使用；否则请先停止占用进程`,
    )
  }

  const maxConnections = opts.maxConnections ?? 8
  const clients = new Set<ClientState>()
  const pending: BatchJob[] = []
  let processing = false
  /** 当前事务持有者（isInTransaction 期间队列只处理它的批次） */
  let transactionOwner: ClientState | null = null
  const debug = process.env.DB_SERVER_DEBUG === '1'
  const log = (...args: unknown[]) => {
    if (debug) console.error('[db-server]', ...args)
  }

  async function pump(): Promise<void> {
    if (processing) return
    processing = true
    try {
      while (pending.length > 0) {
        let idx = -1
        for (let i = 0; i < pending.length; i++) {
          const job = pending[i]!
          if (
            job.force ||
            job.client === null ||
            transactionOwner === null ||
            job.client === transactionOwner ||
            !db.isInTransaction()
          ) {
            idx = i
            break
          }
        }
        if (idx === -1) {
          log('pump 等待事务持有者新批次，队列长度', pending.length, 'owner在连接中:', transactionOwner ? clients.has(transactionOwner) : '无')
          break // 事务持有者暂无新批次：等待
        }
        const job = pending.splice(idx, 1)[0]!
        if (job.client !== null && job.client.closed) {
          job.resolve()
          continue
        }
        const batchTypes = job.data.subarray(0, Math.min(job.data.length, 64)).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
        log('执行批次 client=', job.client?.socket.remotePort, 'force=', job.force, '首类型=', String.fromCharCode(job.data[0]!), '长度=', job.data.length, '内容=', batchTypes, '队列剩余', pending.length)
        try {
          if (job.client !== null) {
            // 记录可能开启事务的客户端
            if (!db.isInTransaction()) transactionOwner = job.client
            let respBytes = 0
            await db.execProtocolRawStream(job.data, {
              onRawData: (data) => {
                respBytes += data.length
                const c = job.client
                if (c && !c.closed && c.socket.writable) {
                  c.socket.write(Buffer.from(data))
                }
              },
            })
            log('批次完成 client=', job.client.socket.remotePort, '响应字节=', respBytes)
          } else {
            await db.execProtocolRawStream(job.data, {
              onRawData: () => {
                /* 无绑定客户端：丢弃响应 */
              },
            })
          }
          job.resolve()
        } catch (err) {
          job.reject(err)
        }
        // 批次结束后：事务若已结束则释放 owner
        if (transactionOwner && !db.isInTransaction()) transactionOwner = null
      }
    } finally {
      processing = false
    }
  }

  function enqueue(job: BatchJob): void {
    pending.push(job)
    void pump()
  }

  /** 系统批次（client=null）：响应丢弃，不进入任何客户端响应流 */
  function enqueueSystemBatch(data: Buffer): void {
    enqueue({ client: null, force: false, data, resolve: () => {}, reject: () => {} })
  }

  function disconnectCleanup(client: ClientState): void {
    if (client.closed) return
    client.closed = true
    clients.delete(client)
    if (transactionOwner === client) {
      // 事务中持有的客户端断开：回滚（以强制批次形式走同一队列）
      transactionOwner = null
      enqueue({
        client: null,
        force: true,
        data: queryMessage('ROLLBACK'),
        resolve: () => {},
        reject: () => {},
      })
    }
    // 清理本客户端残留的独占 statement 名（响应丢弃）
    if (client.unnamedStmt !== null) {
      enqueueSystemBatch(closeStmtMessage(client.unnamedStmt))
      client.unnamedStmt = null
    }
    void pump()
  }

  /** 处理一个客户端 socket 的字节流，切成批次入队 */
  function handleClient(socket: net.Socket): void {
    if (clients.size >= maxConnections) {
      socket.destroy()
      return
    }
    const client: ClientState = { socket, closed: false, batch: [], unnamedStmt: null }
    clients.add(client)
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let started = false

    socket.on('data', (chunk) => {
      if (client.closed) return
      buffer = Buffer.concat([buffer, chunk])
      // 消息切分循环
      for (;;) {
        if (!started) {
          // 首个消息：Startup / SSLRequest / CancelRequest（无类型字节）
          if (buffer.length < 8) break
          const len = buffer.readInt32BE(0)
          const code = buffer.readInt32BE(4)
          if (len === 8 && code === SSL_REQUEST_CODE) {
            socket.write(Buffer.from('N'))
            buffer = buffer.subarray(8)
            continue
          }
          if (len === 16 && code === CANCEL_REQUEST_CODE) {
            // 取消请求：pglite-socket 同样忽略（not supported）
            buffer = buffer.subarray(16)
            continue
          }
          if (code === STARTUP_CODE) {
            if (buffer.length < len) break
            // 深复制：socket data chunk 由 Node 内部池化管理，回调返回后内存可被复用，
            // subarray 视图跨事件持有会被后续数据污染（实测导致扩展协议消息串扰）
            const msg = Buffer.from(buffer.subarray(0, len))
            buffer = buffer.subarray(len)
            started = true
            enqueueBatch(client, msg)
            continue
          }
          // 未知首包：拒绝
          socket.destroy()
          return
        }
        // 常规消息：[类型 1 字节][长度 4 字节]
        if (buffer.length < 5) break
        const msgLen = 1 + buffer.readInt32BE(1)
        if (buffer.length < msgLen) break
        // 深复制（同上）：不能跨事件持有 socket 池化内存的视图
        const msg = Buffer.from(buffer.subarray(0, msgLen))
        buffer = buffer.subarray(msgLen)
        consumeMessage(client, msg)
      }
    })

    function consumeMessage(client: ClientState, msg: Buffer): void {
      const type = String.fromCharCode(msg[0]!)
      if (EXTENDED_TYPES.has(type)) {
        let out = msg
        if (type === 'P') {
          const stmtEnd = cstringEnd(msg, 5)
          const name = msg.subarray(5, stmtEnd).toString('utf8')
          if (name === '') {
            const old = client.unnamedStmt
            const newName = allocStmtName()
            // 覆盖语义：新 Parse 入队前，以系统批次（响应丢弃）Close 旧名
            if (old !== null) enqueueSystemBatch(closeStmtMessage(old))
            client.unnamedStmt = newName
            out = rewriteParseUnnamed(msg, newName)
          }
        } else if (type === 'B') {
          if (client.unnamedStmt !== null) {
            const stmtStart = bindStmtStart(msg)
            const stmtEnd = cstringEnd(msg, stmtStart)
            if (stmtEnd === stmtStart) {
              out = rewriteBindUnnamed(msg, client.unnamedStmt)
            }
          }
        } else if (type === 'D' || type === 'C') {
          // Describe/Close：type 字节（'S'=statement / 'P'=portal）在 offset 5
          if (String.fromCharCode(msg[5]!) === 'S' && client.unnamedStmt !== null) {
            const nameEnd = cstringEnd(msg, 6)
            if (nameEnd === 6) {
              out = rewriteNamedRefUnnamed(msg, client.unnamedStmt)
              if (type === 'C') client.unnamedStmt = null
            }
          }
        }
        client.batch.push(out)
        if (type === 'S' || type === 'H') {
          // 批次完整（Sync/Flush）：作为整体入队
          const batch = client.batch
          client.batch = []
          enqueueBatch(client, batch.length === 1 ? batch[0]! : Buffer.concat(batch))
        }
        return
      }
      // 非扩展协议消息（Q/X/p 等）：独立入队（先冲刷可能残留的批次，防御协议违规）
      if (client.batch.length > 0) {
        const batch = client.batch
        client.batch = []
        enqueueBatch(client, Buffer.concat(batch))
      }
      enqueueBatch(client, msg)
    }

    function enqueueBatch(client: ClientState, data: Buffer): void {
      enqueue({
        client,
        force: false,
        data,
        resolve: () => {},
        reject: (err) => {
          const message = err instanceof Error ? err.message : String(err)
          try {
            socket.write(makeErrorResponse(`pglite 批次执行失败: ${message}`))
          } catch {
            /* ignore */
          }
          socket.destroy()
        },
      })
    }

    socket.on('error', () => {
      disconnectCleanup(client)
    })
    socket.on('close', () => {
      disconnectCleanup(client)
    })
  }

  const server = net.createServer(handleClient)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, '127.0.0.1', () => resolve())
  })

  return {
    host: '127.0.0.1',
    port: requestedPort,
    url: `postgres://codeatlas:local@127.0.0.1:${requestedPort}/codeatlas`,
    stop: async () => {
      for (const c of clients) {
        try {
          c.socket.destroy()
        } catch {
          /* ignore */
        }
      }
      clients.clear()
      if (db.isInTransaction()) {
        try {
          await db.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await db.close()
    },
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('db-server.ts')

if (isMain) {
  const port = Number(process.argv[2]) || 5433
  startDbServer({ port })
    .then((handle) => {
      console.log(`[db-server] PGlite + pgvector 已启动: ${handle.url}`)
      console.log('[db-server] Ctrl+C 停止')
    })
    .catch((err) => {
      console.error('[db-server] 启动失败:', err)
      process.exit(1)
    })
}
