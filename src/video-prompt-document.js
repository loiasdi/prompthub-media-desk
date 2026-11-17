// 原文是唯一存储来源；目录只记录位置，不重写镜头、台词或换行。
export const MAX_PROMPT_TEXT = 500000

export function indexVideoPrompt(text = '') {
  const headings = [...text.matchAll(/^[ \t]*【第\s*([^\s段】]+)\s*段\s*[-－—–]\s*(\d+(?:\.\d+)?)\s*秒】[^\r\n]*/gm)]
  const sections = headings.map((match, index) => {
    const start = match.index
    const end = headings[index + 1]?.index ?? text.length
    const body = text.slice(start, end)
    return { label: match[0].trim(), seconds: Number(match[2]), start, end, text: body, shots: [...body.matchAll(/^[ \t]*镜头[^：:\r\n]+[：:]/gm)].length }
  })
  const prefix = sections.length ? text.slice(0, sections[0].start) : text
  // 分镜脚本标题属于段落正文，而非每次生成都需要的全局参数。
  const global = prefix.replace(/(?:\r?\n)?[ \t]*分镜脚本[：:][ \t]*(?:\r?\n[ \t]*)*$/, '').trimEnd()
  return { global, sections, seconds: sections.reduce((sum, section) => sum + section.seconds, 0) }
}

export function copyVideoPromptSection(text, index) {
  const document = indexVideoPrompt(text)
  const section = document.sections[index]
  if (!section) return ''
  return [document.global, section.text.trimEnd()].filter(Boolean).join('\n\n')
}
