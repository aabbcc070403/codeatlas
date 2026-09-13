import { z } from 'zod'
import type { ToolSpec } from './provider'

/**
 * 受限工具合同（规格 9.2）：read_file / search_code / list_imports / retrieve_guidelines。
 * 参数由服务器验证；不接受 URL、SQL、命令与绝对路径；无终端与联网工具。
 */

export const readFileInput = z.object({
  path: z.string().min(1).max(300),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
})

export const searchCodeInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10),
})

export const listImportsInput = z.object({
  path: z.string().min(1).max(300),
})

export const retrieveGuidelinesInput = z.object({
  query: z.string().min(1).max(200),
  topK: z.number().int().min(1).max(8).default(5),
})

export const MAX_READ_LINES = 200

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description:
      `读取当前快照中一个文件的一段代码（一次最多 ${MAX_READ_LINES} 行）。path 必须是快照内相对路径。返回内容已脱敏。`,
    parameters: readFileInput,
  },
  {
    name: 'search_code',
    description:
      '在当前快照内按字面量搜索代码（非正则），返回最多 20 个命中行。用于定位符号或调用点。',
    parameters: searchCodeInput,
  },
  {
    name: 'list_imports',
    description: '列出一个文件的导入及其解析结果（仅已解析的相对导入）。',
    parameters: listImportsInput,
  },
  {
    name: 'retrieve_guidelines',
    description: '从规范知识库（预置 + 当前项目规范）检索相关条目，返回块 id 与原文。',
    parameters: retrieveGuidelinesInput,
  },
]
