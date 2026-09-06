/**
 * Office 办公插件后端
 *
 * 注册 AI 可调用工具：
 *   createPptx - 用 pptxgenjs 生成 PowerPoint 演示文稿（.pptx）
 *   createDocx - 用 docx 生成 Word 文档（.docx）
 *
 * 场景（ppt-assistant / word-assistant）与技能（office-guide）由 plugin.json 声明式注册。
 */

import { readOfficeFile, replaceOfficeText } from './officeFileService.js'

export function register(ctx) {
  const { registerTool, logger, importModule } = ctx

  registerTool({
    id: 'readOffice',
    name: '读取Office文档',
    description: '读取已有 .docx 或 .pptx，提取可供 AI 理解的正文、幻灯片文本、元数据和警告。',
    parameters: { type: 'object', properties: { filePath: { type: 'string', description: '工作区内的 .docx/.pptx 路径' } }, required: ['filePath'] },
    tags: ['office', 'readonly'],
    async handler({ filePath, _workspaceDir }) {
      try { return { success: true, ...(await readOfficeFile(filePath, _workspaceDir, importModule)) } } catch (error) { return { success: false, error: `读取Office文档失败: ${error.message}` } }
    }
  })

  registerTool({
    id: 'editOfficeText',
    name: '编辑Office文档',
    description: '对已有 .docx/.pptx 做原文替换并写回或另存为。适合修改标题、日期、数字、名称等；不会重建原文件的版式、图片和主题。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '源 .docx/.pptx 路径' },
        outputPath: { type: 'string', description: '另存为路径；省略则原地修改' },
        replacements: { type: 'object', description: '键为原文，值为新文，例如 {"2025年": "2026年"}' }
      },
      required: ['filePath', 'replacements']
    },
    tags: ['office'],
    async handler({ filePath, outputPath, replacements, _workspaceDir }) {
      try { return await replaceOfficeText(filePath, replacements, outputPath, _workspaceDir, importModule) } catch (error) { return { success: false, error: `编辑Office文档失败: ${error.message}` } }
    }
  })

  // ============================================================
  // createPptx — PowerPoint 演示文稿生成
  // ============================================================
  registerTool({
    id: 'createPptx',
    name: '生成PPT',
    description: '生成专业 PowerPoint：支持主题色、副标题、单栏/双栏、项目符号、表格、图片、页脚和演讲者备注。旧版 title/body 参数继续兼容。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '输出文件路径，相对工作区根或绝对路径，必须以 .pptx 结尾' },
        title: { type: 'string', description: '演示文稿主题，作为封面标题' },
        subtitle: { type: 'string', description: '封面副标题（可选）' },
        theme: { type: 'object', description: '主题配置，可传 { primary, accent, background, fontFace }' },
        slides: {
          type: 'array',
          description: '幻灯片列表（不含封面），每张包含标题与要点',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '幻灯片标题' },
              body: { type: 'array', items: { type: 'string' }, description: '要点列表' },
              layout: { type: 'string', enum: ['title-body', 'two-column', 'quote', 'blank'], description: '版式（可选）' },
              left: { type: 'array', items: { type: 'string' }, description: '双栏左侧要点' },
              right: { type: 'array', items: { type: 'string' }, description: '双栏右侧要点' },
              table: { type: 'object', description: '表格：{ headers: string[], rows: string[][] }' },
              image: { type: 'string', description: '本地图片路径（可选）' },
              notes: { type: 'string', description: '演讲者备注（可选）' }
            },
            required: ['title']
          }
        },
        footer: { type: 'string', description: '页脚文字（可选）' },
        author: { type: 'string', description: '作者（可选）' }
      },
      required: ['filePath', 'title', 'slides']
    },
    tags: ['office'],
    async handler(params) {
      const { filePath, title, subtitle, slides = [], footer, author, theme = {} } = params
      try {
        const path = await import('path')
        const root = params._workspaceDir?.root || process.cwd()
        const absolutePath = path.resolve(root, filePath)
        if (!absolutePath.toLowerCase().endsWith('.pptx')) {
          return { success: false, error: '输出文件必须以 .pptx 结尾' }
        }

        const mod = await importModule('pptxgenjs')
        const PptxGenJS = mod.default || mod
        const pptx = new PptxGenJS()
        pptx.layout = 'LAYOUT_WIDE'
        pptx.author = author || 'Artificer'
        const colors = { primary: '1F4E79', accent: '2E75B6', background: 'FFFFFF', text: '333333', fontFace: 'Arial', ...theme }

        // 封面
        const cover = pptx.addSlide()
        cover.background = { color: colors.background }
        cover.addText(title || '演示文稿', {
          x: 0.5, y: 2.8, w: 12.3, h: 1.2,
          fontSize: 40, bold: true, align: 'center', color: colors.primary, fontFace: colors.fontFace
        })
        if (subtitle) cover.addText(subtitle, { x: 1, y: 4.2, w: 11.3, h: 0.5, fontSize: 20, align: 'center', color: colors.accent, fontFace: colors.fontFace })

        // 内容页
        for (const slide of slides) {
          const s = pptx.addSlide()
          s.background = { color: colors.background }
          const layout = slide.layout || 'title-body'
          if (layout !== 'blank') s.addText(slide.title || '', {
            x: 0.5, y: 0.3, w: 12.3, h: 0.8,
            fontSize: 28, bold: true, color: colors.primary, fontFace: colors.fontFace
          })
          const body = Array.isArray(slide.body)
            ? slide.body
            : (typeof slide.body === 'string' ? slide.body.split('\n') : [])
          // pptxgenjs 4.x：数组元素须为 { text, options } 对象
          const addBullets = (items, x, y, w, h) => {
            const values = (Array.isArray(items) ? items : []).map(item => ({ text: String(item), options: { bullet: { code: '2022' } } }))
            if (values.length) s.addText(values, { x, y, w, h, fontSize: 16, color: colors.text, fontFace: colors.fontFace, valign: 'top', breakLine: true, paraSpaceAfterPt: 10 })
          }
          if (layout === 'two-column') {
            addBullets(slide.left || body, 0.6, 1.5, 5.8, 4.8)
            addBullets(slide.right, 6.8, 1.5, 5.8, 4.8)
          } else if (layout === 'quote') {
            s.addText(body.join('\n'), { x: 1.1, y: 2.0, w: 11, h: 2.5, fontSize: 28, italic: true, align: 'center', color: colors.accent, fontFace: colors.fontFace, valign: 'mid' })
          } else {
            addBullets(body, 0.5, 1.4, 12.3, 5.2)
          }
          if (slide.table?.headers && Array.isArray(slide.table.rows)) {
            const rows = [slide.table.headers, ...slide.table.rows].map((row, i) => row.map(cell => ({ text: String(cell), options: i === 0 ? { bold: true, color: 'FFFFFF', fill: colors.primary } : {} })))
            s.addTable(rows, { x: 0.6, y: 1.35, w: 12, h: 4.8, border: { type: 'solid', color: 'D9E2F3', pt: 1 }, fontFace: colors.fontFace, fontSize: 13, color: colors.text, autoFit: false })
          }
          if (slide.image) s.addImage({ path: path.resolve(root, slide.image), x: 8.5, y: 1.4, w: 4, h: 3 })
          if (slide.notes && typeof s.addNotes === 'function') s.addNotes(slide.notes)
          if (footer) s.addText(footer, { x: 0.5, y: 7.05, w: 12.3, h: 0.2, fontSize: 9, color: '777777', fontFace: colors.fontFace, align: 'right' })
        }

        const fs = await import('fs/promises')
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await pptx.writeFile({ fileName: absolutePath })
        return { success: true, filePath: absolutePath, slides: slides.length + 1, contentSlides: slides.length }
      } catch (error) {
        return { success: false, error: `生成PPT失败: ${error.message}` }
      }
    }
  })

  // ============================================================
  // createDocx — Word 文档生成
  // ============================================================
  registerTool({
    id: 'createDocx',
    name: '生成Word文档',
    description: '生成专业 Word 文档：支持富文本、标题层级、项目符号、表格、分页、页眉页脚和作者信息。旧版 sections/paragraphs 参数继续兼容。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '输出文件路径，相对工作区根或绝对路径，必须以 .docx 结尾' },
        title: { type: 'string', description: '文档标题（居中显示）' },
        author: { type: 'string', description: '作者（可选）' },
        header: { type: 'string', description: '页眉（可选）' },
        footer: { type: 'string', description: '页脚（可选）' },
        sections: {
          type: 'array',
          description: '章节列表，每章包含标题与段落',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: '章节标题' },
              headingLevel: { type: 'number', description: '标题级别 1-3（可选）' },
              paragraphs: { type: 'array', items: { type: 'object' }, description: '段落，可为字符串或 { text, bold, italic, bullet, level, pageBreakBefore }' },
              table: { type: 'object', description: '表格：{ headers: string[], rows: string[][] }' }
            }
          }
        }
      },
      required: ['filePath', 'title']
    },
    tags: ['office'],
    async handler(params) {
      const { filePath, title, sections = [], author, header, footer } = params
      try {
        const path = await import('path')
        const root = params._workspaceDir?.root || process.cwd()
        const absolutePath = path.resolve(root, filePath)
        if (!absolutePath.toLowerCase().endsWith('.docx')) {
          return { success: false, error: '输出文件必须以 .docx 结尾' }
        }

        const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, Header, Footer, PageNumber } = await importModule('docx')

        const children = []
        if (title) {
          children.push(new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: title, bold: true })]
          }))
        }
        const headingMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 }
        for (const section of sections) {
          if (section.heading) {
            children.push(new Paragraph({
              heading: headingMap[section.headingLevel] || HeadingLevel.HEADING_1,
              children: [new TextRun({ text: section.heading, bold: true })]
            }))
          }
          const paragraphs = Array.isArray(section.paragraphs)
            ? section.paragraphs
            : (typeof section.paragraphs === 'string' ? [section.paragraphs] : [])
          for (const value of paragraphs) {
            const item = typeof value === 'string' ? { text: value } : (value || {})
            children.push(new Paragraph({
              pageBreakBefore: !!item.pageBreakBefore,
              bullet: item.bullet ? { level: Number.isInteger(item.level) ? item.level : 0 } : undefined,
              children: [new TextRun({ text: String(item.text ?? ''), bold: !!item.bold, italics: !!item.italic })]
            }))
          }
          if (section.table?.headers && Array.isArray(section.table.rows)) {
            const makeCell = text => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: true })] })] })
            children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: section.table.headers.map(makeCell) }), ...section.table.rows.map(row => new TableRow({ children: row.map(text => new TableCell({ children: [new Paragraph(String(text ?? ''))] })) }))] }))
          }
        }

        const makeLine = (text, isFooter = false) => new Paragraph({ alignment: isFooter ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun(String(text)), ...(isFooter ? [new TextRun('  '), PageNumber.CURRENT] : [])] })
        const doc = new Document({ creator: author || 'Artificer', sections: [{ children, headers: header ? { default: new Header({ children: [makeLine(header)] }) } : undefined, footers: footer ? { default: new Footer({ children: [makeLine(footer, true)] }) } : undefined }] })
        const fs = await import('fs/promises')
        const buffer = await Packer.toBuffer(doc)
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await fs.writeFile(absolutePath, buffer)

        return { success: true, filePath: absolutePath, paragraphs: children.length }
      } catch (error) {
        return { success: false, error: `生成Word文档失败: ${error.message}` }
      }
    }
  })

  logger.info('Office plugin registered: tools=createPptx, createDocx')
}
