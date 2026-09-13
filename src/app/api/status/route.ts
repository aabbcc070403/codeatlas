import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { requireSession } from '@/server/auth/guard'
import { aiProviderStatus } from '@/server/env'
import { SCAN_RULE_VERSION, PROMPT_VERSION } from '@/core/contracts/scan'

export const runtime = 'nodejs'

/** 运行状态：AI provider 配置（不含密钥）、规则/提示词版本 */
export async function GET(req: NextRequest) {
  try {
    await requireSession(getDb(), req)
    const ai = aiProviderStatus()
    return jsonOk({
      ai: {
        provider: ai.provider,
        ready: ai.ready,
        missing: ai.missing,
        chatReady: ai.chatReady,
        embeddingReady: ai.embeddingReady,
        chatModel: ai.chatModel,
        embeddingModel: ai.embeddingModel,
      },
      versions: {
        rules: SCAN_RULE_VERSION,
        prompt: PROMPT_VERSION,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
