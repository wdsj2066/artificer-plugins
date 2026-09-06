/**
 * office/server.test.js - Office 办公插件测试
 *
 * 验证：
 * 1. register(ctx) 注册 createPptx / createDocx 两个工具
 * 2. 注册 ppt-assistant / word-assistant 两个场景（access 白名单正确）
 * 3. createPptx 真实生成 .pptx 文件（zip 魔数校验）
 * 4. createDocx 真实生成 .docx 文件（zip 魔数校验）
 * 5. 非法扩展名被拒绝
 * 6. plugin.json 声明式 skills（office-guide）合法存在
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { register } from '../../plugins/office/server.js'

const PLUGIN_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '../../plugins/office/plugin.json')

function isZipFile(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

describe('Office 办公插件', () => {
  let registered
  let tmpDir

  function makeFakeCtx() {
    registered = { tools: [] }
    return {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      importModule: name => import(name),
      registerTool: (config) => { registered.tools.push(config); return true }
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'office-test-'))
    register(makeFakeCtx())
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('注册内容', () => {
    it('注册 createPptx 与 createDocx 两个工具', () => {
      const ids = registered.tools.map(t => t.id)
      expect(ids).toContain('createPptx')
      expect(ids).toContain('createDocx')
      expect(ids).toContain('readOffice')
      expect(ids).toContain('editOfficeText')
      for (const tool of registered.tools) {
        expect(typeof tool.handler).toBe('function')
      }
    })

    it('plugin.json 声明 ppt-assistant 与 word-assistant 两个场景，access 白名单正确', () => {
      const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf-8'))
      const scenarios = manifest.scenario
      expect(Array.isArray(scenarios)).toBe(true)

      const ppt = scenarios.find(s => s.id === 'ppt-assistant')
      expect(ppt).toBeDefined()
      expect(ppt.access.tools).toContain('createPptx')
      expect(ppt.access.skills).toContain('office-guide')
      expect(typeof ppt.promptFile).toBe('string')

      const word = scenarios.find(s => s.id === 'word-assistant')
      expect(word).toBeDefined()
      expect(word.access.tools).toContain('createDocx')
      expect(word.access.skills).toContain('office-guide')
      expect(typeof word.promptFile).toBe('string')
    })

    it('plugin.json 声明式 skills 数组包含 office-guide', () => {
      const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf-8'))
      expect(Array.isArray(manifest.skills)).toBe(true)
      const guide = manifest.skills.find(s => s.id === 'office-guide')
      expect(guide).toBeDefined()
      expect(typeof guide.content).toBe('string')
    })
  })

  describe('createPptx 工具', () => {
    it('生成有效的 .pptx 文件', async () => {
      const tool = registered.tools.find(t => t.id === 'createPptx')
      const output = join(tmpDir, 'demo.pptx')

      const result = await tool.handler({
        filePath: output,
        title: '季度汇报',
        slides: [
          { title: '业务概览', body: ['营收增长 20%', '新签客户 35 家'] },
          { title: '下季度计划', body: ['拓展华东市场', '上线新版本'] }
        ],
        _workspaceDir: { root: tmpDir }
      })

      expect(result.success).toBe(true)
      expect(result.filePath).toBe(output)
      const buffer = readFileSync(output)
      expect(isZipFile(buffer)).toBe(true)
      expect(buffer.length).toBeGreaterThan(1000)
    })

    it('非 .pptx 扩展名被拒绝', async () => {
      const tool = registered.tools.find(t => t.id === 'createPptx')
      const result = await tool.handler({
        filePath: join(tmpDir, 'demo.txt'),
        title: '测试',
        slides: [],
        _workspaceDir: { root: tmpDir }
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('.pptx')
    })

    it('支持主题、双栏、表格与演讲者备注', async () => {
      const tool = registered.tools.find(t => t.id === 'createPptx')
      const output = join(tmpDir, 'rich.pptx')
      const result = await tool.handler({
        filePath: output,
        title: '产品发布',
        subtitle: '2026 春季版本',
        theme: { primary: '0F766E', accent: '14B8A6' },
        footer: 'Artificer',
        slides: [
          { title: '重点', layout: 'two-column', left: ['更快'], right: ['更稳'], notes: '强调客户价值' },
          { title: '指标', table: { headers: ['指标', '结果'], rows: [['转化率', '32%']] } }
        ],
        _workspaceDir: { root: tmpDir }
      })
      expect(result.success).toBe(true)
      expect(result.slides).toBe(3)
      expect(readFileSync(output).length).toBeGreaterThan(1500)
    })

    it('可读取并原文替换已有 PPT', async () => {
      const create = registered.tools.find(t => t.id === 'createPptx')
      const read = registered.tools.find(t => t.id === 'readOffice')
      const edit = registered.tools.find(t => t.id === 'editOfficeText')
      const source = join(tmpDir, 'source.pptx')
      const target = join(tmpDir, 'edited.pptx')
      await create.handler({ filePath: source, title: '旧标题', slides: [{ title: '旧章节', body: ['旧内容'] }], _workspaceDir: { root: tmpDir } })
      const before = await read.handler({ filePath: source, _workspaceDir: { root: tmpDir } })
      expect(before.success).toBe(true)
      expect(before.text).toContain('旧标题')
      const result = await edit.handler({ filePath: source, outputPath: target, replacements: { '旧标题': '新标题' }, _workspaceDir: { root: tmpDir } })
      expect(result.success).toBe(true)
      expect(existsSync(target)).toBe(true)
      const after = await read.handler({ filePath: target, _workspaceDir: { root: tmpDir } })
      expect(after.text).toContain('新标题')
    })
  })

  describe('createDocx 工具', () => {
    it('生成有效的 .docx 文件', async () => {
      const tool = registered.tools.find(t => t.id === 'createDocx')
      const output = join(tmpDir, 'demo.docx')

      const result = await tool.handler({
        filePath: output,
        title: '会议纪要',
        sections: [
          { heading: '议题', paragraphs: ['回顾上季度目标达成情况', '讨论下季度优先级'] },
          { heading: '结论', paragraphs: ['下季度聚焦华东市场。'] }
        ],
        _workspaceDir: { root: tmpDir }
      })

      expect(result.success).toBe(true)
      expect(result.filePath).toBe(output)
      const buffer = readFileSync(output)
      expect(isZipFile(buffer)).toBe(true)
      expect(buffer.length).toBeGreaterThan(1000)
    })

    it('非 .docx 扩展名被拒绝', async () => {
      const tool = registered.tools.find(t => t.id === 'createDocx')
      const result = await tool.handler({
        filePath: join(tmpDir, 'demo.md'),
        title: '测试',
        sections: [],
        _workspaceDir: { root: tmpDir }
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('.docx')
    })

    it('支持富文本、项目符号、表格和页眉页脚', async () => {
      const tool = registered.tools.find(t => t.id === 'createDocx')
      const output = join(tmpDir, 'rich.docx')
      const result = await tool.handler({
        filePath: output,
        title: '项目方案',
        author: '产品团队',
        header: '内部资料',
        footer: '请勿外传',
        sections: [{
          heading: '目标', headingLevel: 2,
          paragraphs: [
            { text: '核心目标', bold: true },
            { text: '第一项', bullet: true },
            { text: '第二项', bullet: true, level: 1, pageBreakBefore: true }
          ],
          table: { headers: ['负责人', '截止日期'], rows: [['张三', '2026-09-01']] }
        }],
        _workspaceDir: { root: tmpDir }
      })
      expect(result.success).toBe(true)
      expect(result.paragraphs).toBeGreaterThan(3)
      expect(readFileSync(output).length).toBeGreaterThan(1500)
    })

    it('可读取并原文替换已有 Word', async () => {
      const create = registered.tools.find(t => t.id === 'createDocx')
      const read = registered.tools.find(t => t.id === 'readOffice')
      const edit = registered.tools.find(t => t.id === 'editOfficeText')
      const source = join(tmpDir, 'source.docx')
      const target = join(tmpDir, 'edited.docx')
      await create.handler({ filePath: source, title: '旧标题', sections: [{ heading: '正文', paragraphs: ['旧内容'] }], _workspaceDir: { root: tmpDir } })
      const before = await read.handler({ filePath: source, _workspaceDir: { root: tmpDir } })
      expect(before.success).toBe(true)
      expect(before.text).toContain('旧标题')
      const result = await edit.handler({ filePath: source, outputPath: target, replacements: { '旧标题': '新标题' }, _workspaceDir: { root: tmpDir } })
      expect(result.success).toBe(true)
      const after = await read.handler({ filePath: target, _workspaceDir: { root: tmpDir } })
      expect(after.text).toContain('新标题')
    })
  })
})
