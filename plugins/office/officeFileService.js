import path from 'node:path'
import fs from 'node:fs/promises'
const SUPPORTED = new Set(['.docx', '.pptx'])

function resolveOfficePath(filePath, workspaceDir) {
  const root = workspaceDir?.root || process.cwd()
  const absolute = path.resolve(root, filePath)
  if (!SUPPORTED.has(path.extname(absolute).toLowerCase())) throw new Error('仅支持 .docx 和 .pptx 文件')
  return absolute
}

export async function readOfficeFile(filePath, workspaceDir, importModule) {
  const absolute = resolveOfficePath(filePath, workspaceDir)
  const { parseOffice } = await importModule('officeparser')
  const ast = await parseOffice(absolute, { ignoreNotes: false, includeFormatting: true })
  return {
    filePath: absolute,
    type: path.extname(absolute).slice(1),
    text: String(typeof ast.toText === 'function' ? ast.toText() : '').slice(0, 120000),
    metadata: ast.metadata || {},
    content: ast.content || [],
    warnings: ast.warnings || []
  }
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function replaceAcrossRuns(xml, from, to, tag) {
  const paragraphPattern = tag === 'w' ? /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g : /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g
  const textPattern = tag === 'w' ? /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g : /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/g
  let changed = 0
  const result = xml.replace(paragraphPattern, paragraph => {
    const nodes = [...paragraph.matchAll(textPattern)]
    if (nodes.length < 2) return paragraph
    const combined = nodes.map(node => node[2]).join('')
    const escapedFrom = xmlEscape(from)
    const index = combined.indexOf(escapedFrom)
    if (index < 0) return paragraph
    const replacement = xmlEscape(to)
    let cursor = 0
    let output = paragraph.replace(textPattern, (full, open, value, close) => {
      const start = cursor
      cursor += value.length
      const end = cursor
      if (start <= index && end >= index + escapedFrom.length) return `${open}${value.slice(0, index - start)}${replacement}${value.slice(index - start + escapedFrom.length)}${close}`
      if (start >= index && end <= index + escapedFrom.length) return `${open}${close}`
      return full
    })
    if (output !== paragraph) changed += 1
    return output
  })
  return { xml: result, changed }
}

export async function replaceOfficeText(filePath, replacements, outputPath, workspaceDir, importModule) {
  const source = resolveOfficePath(filePath, workspaceDir)
  const target = outputPath ? resolveOfficePath(outputPath, workspaceDir) : source
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) throw new Error('replacements 必须是“原文:新文”的对象')
  const JSZip = (await importModule('jszip')).default
  const zip = await JSZip.loadAsync(await fs.readFile(source))
  const entries = Object.entries(replacements).filter(([from]) => from.length > 0)
  let changed = 0
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name) || zip.files[name].dir) continue
    const original = await zip.files[name].async('string')
    let updated = original
    for (const [from, to] of entries) {
      const before = updated
      updated = updated.split(xmlEscape(from)).join(xmlEscape(to))
      if (updated === before) {
        const w = replaceAcrossRuns(updated, from, to, 'w')
        const a = replaceAcrossRuns(w.xml, from, to, 'a')
        updated = a.xml
        changed += w.changed + a.changed
      }
      if (updated !== before) changed += 1
    }
    if (updated !== original) zip.file(name, updated)
  }
  if (!changed) return { success: false, error: '未找到可替换的原文', filePath: target, changed: 0 }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { success: true, filePath: target, changed, inPlace: source === target }
}
