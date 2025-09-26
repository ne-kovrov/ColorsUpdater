/// <reference types="@figma/plugin-typings" />

type ReportItem = { kind: 'warn' | 'error'; nodeName?: string; nodeId?: string; detail: string }
type MapRow = { styleName: string; variableName: string; collectionName?: string }
type CatalogRow = { name: string; key?: string; id?: string; collectionName?: string; type?: string }
figma.showUI(__html__, { width: 560, height: 560 })
figma.ui.onmessage = async (msg: any) => {
  console.log('Плагин получил сообщение:', msg)
  if (msg.type === 'cancel') {
    figma.closePlugin()
    return
  }
  if (msg.type === 'load-data') {
    try {
      const [savedCatalog, savedMapping] = await Promise.all([
        figma.clientStorage.getAsync('catalog'),
        figma.clientStorage.getAsync('mapping')
      ])
      figma.ui.postMessage({ 
        type: 'data-loaded', 
        catalog: savedCatalog || '', 
        mapping: savedMapping || '' 
      })
    } catch (e) {
      console.error('Ошибка при загрузке данных:', e)
      figma.ui.postMessage({ type: 'data-loaded', catalog: '', mapping: '' })
    }
    return
  }
  if (msg.type === 'save-catalog') {
    try {
      await figma.clientStorage.setAsync('catalog', msg.text || '')
      console.log('Каталог сохранен в clientStorage')
    } catch (e) {
      console.error('Ошибка при сохранении каталога:', e)
    }
    return
  }
  if (msg.type === 'save-mapping') {
    try {
      await figma.clientStorage.setAsync('mapping', msg.text || '')
      console.log('Маппинг сохранен в clientStorage')
    } catch (e) {
      console.error('Ошибка при сохранении маппинга:', e)
    }
    return
  }
  if (msg.type === 'clear-data') {
    try {
      await Promise.all([
        figma.clientStorage.deleteAsync('catalog'),
        figma.clientStorage.deleteAsync('mapping')
      ])
      console.log('Данные удалены из clientStorage')
    } catch (e) {
      console.error('Ошибка при удалении данных:', e)
    }
    return
  }
  if (msg.type === 'collect-catalog') {
    console.log('Начинаем сбор каталога...')
    try {
      const text = await buildCatalogCsvFromThisFile()
      console.log('Каталог собран, отправляем результат...')
      try {
        figma.ui.postMessage({ type: 'catalog-result', text })
        console.log('Сообщение отправлено в UI')
      } catch (e) {
        console.error('Ошибка при отправке сообщения в UI:', e)
      }
    } catch (e) {
      console.error('Ошибка при сборе каталога:', e)
      figma.ui.postMessage({ type: 'error', detail: 'Не удалось собрать каталог: ' + ((e as any)?.message || String(e)) })
    }
    return
  }
  if (msg.type === 'run') {
    try {
      const mapping: MapRow[] = parseMappingCsv(msg.mappingCsv as string)
      const catalog: CatalogRow[] = parseCatalog(msg.catalogCsvOrJson as string)
      await run(mapping, catalog)
    } catch (e) {
      console.error('Критическая ошибка:', e)
      figma.ui.postMessage({ 
        type: 'error', 
        detail: 'Критическая ошибка: ' + ((e as any)?.message || String(e)) 
      })
    } finally {
      figma.closePlugin()
    }
  }
}
function sanitize(s: string) { return s.replace(/^\uFEFF/, '').trim() }
function detectDelimiter(line: string): string {
  const counts = [
    { d: ',', c: (line.match(/,/g) || []).length },
    { d: ';', c: (line.match(/;/g) || []).length },
    { d: '\t', c: (line.match(/\t/g) || []).length },
  ]; counts.sort((a,b)=>b.c-a.c); return counts[0].c>0 ? counts[0].d : ','
}
function parseCSV(content: string): string[][] {
  const text = sanitize(content); if (!text) return []
  const firstLine = text.split(/\r?\n/)[0] || ''; const delim = detectDelimiter(firstLine)
  const rows: string[][] = []; let cur: string[] = []; let field = ''; let inQuotes = false
  for (let i=0;i<text.length;i++){
    const ch=text[i], next=text[i+1]
    if (inQuotes){ if (ch==='\"' && next==='\"'){ field+='\"'; i++ } else if (ch==='\"'){ inQuotes=false } else { field+=ch } continue }
    if (ch==='\"'){ inQuotes=true; continue }
    if (ch===delim){ cur.push(field); field=''; continue }
    if (ch==='\n'){ cur.push(field); rows.push(cur); cur=[]; field=''; continue }
    if (ch==='\r'){ continue }
    field+=ch
  }
  cur.push(field); rows.push(cur); return rows
}
function parseMappingCsv(csv: string): MapRow[] {
  const rows = parseCSV(csv)
  if (!rows.length) return []
  const header = rows[0].map(s=>s.toLowerCase())
  const looksHeader = header.length>=2 && /style/.test(header[0]) && /variable/.test(header[1])
  const data = looksHeader ? rows.slice(1) : rows
  const res: MapRow[] = []
  for (const r of data) {
    if (r.length < 2) continue
    const styleName = sanitize(r[0])
    const variableName = sanitize(r[1])
    const collectionName = r[2] ? sanitize(r[2]) : undefined
    if (styleName && variableName) res.push({ styleName, variableName, collectionName })
  }
  return res
}
function parseCatalog(text: string): CatalogRow[] {
  const t = sanitize(text || '')
  if (!t) return []
  // Попробуем JSON
  try {
    const j = JSON.parse(t)
    if (Array.isArray(j)) {
      return j.map((o:any)=>({
        name: String(o.name || o.variableName || ''),
        key: o.key || o.variableKey,
        id: o.id || o.variableId,
        collectionName: o.collection || o.collectionName,
        type: o.type || o.resolvedType
      })).filter(x=>x.name)
    }
  } catch {}
  // CSV
  const rows = parseCSV(t)
  if (!rows.length) return []
  const header = rows[0].map(s=>s.trim().toLowerCase())
  const hasHeader = ['name','key','id','collection','collectionname','type'].some((h: string)=>header.includes(h))
  const data = hasHeader ? rows.slice(1) : rows
  const idx = (h: string) => header.indexOf(h)
  const iName = hasHeader ? (idx('name')) : 0
  const iKey = hasHeader ? (idx('key')) : 1
  const iId = hasHeader ? (idx('id')) : 2
  const iCol = hasHeader ? (idx('collection')>=0?idx('collection'):idx('collectionname')) : 3
  const iType = hasHeader ? idx('type') : -1
  const res: CatalogRow[] = []
  for (const r of data) {
    const name = sanitize(r[iName] || '')
    if (!name) continue
    const row: CatalogRow = {
      name,
      key: iKey>=0 ? sanitize(r[iKey] || '') : undefined,
      id: iId>=0 ? sanitize(r[iId] || '') : undefined,
      collectionName: iCol>=0 ? sanitize(r[iCol] || '') : undefined,
      type: iType>=0 ? sanitize(r[iType] || '') : undefined,
    }
    res.push(row)
  }
  return res
}
async function buildCatalogCsvFromThisFile(): Promise<string> {
  const vars = await figma.variables.getLocalVariablesAsync()
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const colsById = new Map(collections.map((c: any)=>[c.id,c]))
  const lines = ['name,key,id,collection,type']
  
  console.log(`Найдено переменных: ${vars.length}`)
  console.log(`Найдено коллекций: ${collections.length}`)
  
  for (const v of vars) {
    const col = colsById.get(v.variableCollectionId)
    const collectionName = col?.name || ''
    const type = (v as any).resolvedType || (v as any).type || ''
    lines.push([csvCell(v.name), csvCell((v as any).key || ''), csvCell(v.id), csvCell(collectionName), csvCell(String(type))].join(','))
  }
  
  const result = lines.join('\n')
  console.log(`Результат каталога: ${result.length} символов`)
  return result
}
function csvCell(s: string){ const t = (s||''); if (/[",\n]/.test(t)) return '"' + t.replace(/"/g,'""') + '"'; return t }
async function run(mapping: MapRow[], catalog: CatalogRow[]) {
  const report: ReportItem[] = []
  if (!mapping.length) {
    console.error('CSV маппинга пуст')
    figma.ui.postMessage({ type: 'error', detail: 'CSV маппинга пуст.' })
    return
  }
  // Индексация локальных переменных (вдруг часть уже локальна)
  const localVars = await figma.variables.getLocalVariablesAsync()
  const localByName = new Map<string, Variable[]>()
  for (const v of localVars) {
    const arr = localByName.get(v.name) || []; arr.push(v); localByName.set(v.name, arr)
  }
  // Индексация каталога
  const catalogByName = new Map<string, CatalogRow[]>()
  for (const row of catalog) {
    const arr = catalogByName.get(row.name) || []; arr.push(row); catalogByName.set(row.name, arr)
  }
  // Кэш импортов по key/id
  const importedByKey = new Map<string, Variable>()
  const importedById = new Map<string, Variable>()
  async function resolveVariableByName(name: string, preferCollection?: string): Promise<Variable | null> {
    // 1) локальные по имени
    const locals = localByName.get(name) || []
    let pickLocal = locals[0]
    if (preferCollection) {
      for (const v of locals) {
        const colName = await collectionNameOf(v)
        if (colName === preferCollection) {
          pickLocal = v
          break
        }
      }
    }
    if (pickLocal && isColorVar(pickLocal)) return pickLocal
    // 2) из каталога по имени (+ колллекция)
    const rows = catalogByName.get(name) || []
    let row: CatalogRow | undefined = rows.find(r => preferCollection ? (r.collectionName === preferCollection) : true) || rows[0]
    if (!row) return null
    // key приоритетнее
    if (row.key && 'importVariableByKeyAsync' in figma.variables && typeof (figma.variables as any).importVariableByKeyAsync === 'function') {
      const cached = importedByKey.get(row.key)
      if (cached) return isColorVar(cached) ? cached : null
      try {
        const v = await (figma.variables as any).importVariableByKeyAsync(row.key)
        importedByKey.set(row.key, v)
        return isColorVar(v) ? v : null
      } catch (e) {
        // попробуем по id
      }
    }
    if (row.id) {
      const cached = importedById.get(row.id)
      if (cached) return isColorVar(cached) ? cached : null
      try {
        const v = figma.variables.getVariableById(row.id)
        if (v) {
          importedById.set(row.id, v)
          return isColorVar(v) ? v : null
        }
      } catch {}
    }
    return null
  }
          const nodes = figma.currentPage.findAll()
        console.log(`Найдено узлов для обработки: ${nodes.length}`)
        
        let processedStyles = 0
        let matchedStyles = 0
        let successfulReplacements = 0
        
        for (const node of nodes) {
          // Обрабатываем все типы стилей для каждого узла
          const styleTypes = [
            { prop: 'fillStyleId', setter: 'setFillStyleIdAsync', binder: 'fills', typeName: 'fill' },
            { prop: 'strokeStyleId', setter: 'setStrokeStyleIdAsync', binder: 'strokes', typeName: 'stroke' },
            { prop: 'effectStyleId', setter: 'setEffectStyleIdAsync', binder: 'effects', typeName: 'effect' }
          ]
          
          for (const styleType of styleTypes) {
            if (styleType.prop in node) {
              const sid = (node as any)[styleType.prop] as string | typeof figma.mixed
              if (sid && sid !== figma.mixed) {
                processedStyles++
                const style = await figma.getStyleByIdAsync(sid as string)
                const styleName = style?.name
                if (styleName) {
                  console.log(`Обрабатываем ${styleType.typeName}-стиль: "${styleName}"`)
                  const row = mapping.find(m => m.styleName === styleName)
                  if (row) {
                    matchedStyles++
                    console.log(`Найден маппинг для "${styleName}" -> "${row.variableName}"`)
                    const v = await resolveVariableByName(row.variableName, row.collectionName)
                    if (!v) {
                      console.log(`Переменная "${row.variableName}" не найдена`)
                      report.push({ kind:'error', nodeName: node.name, nodeId: node.id, detail: `Не найдена переменная "${row.variableName}"${row.collectionName? ` (коллекция "${row.collectionName}")`:''} для ${styleType.typeName}-стиля "${styleName}"` })
                    } else {
                      console.log(`Переменная "${row.variableName}" найдена, привязываем к ${styleType.typeName}`)
                      let ok = false
                      if (styleType.binder === 'effects') {
                        ok = bindVariableToEffects(node as any, v.id, report)
                      } else {
                        ok = bindVariableToPaints(node as any, v.id, styleType.binder as 'fills' | 'strokes', report)
                      }
                      if (ok) {
                        successfulReplacements++
                        console.log(`Успешно привязана переменная к ${styleType.typeName}`)
                        await (node as any)[styleType.setter]('')
                      } else {
                        console.log(`Не удалось привязать переменную к ${styleType.typeName}`)
                      }
                    }
                  } else {
                    console.log(`Нет маппинга для ${styleType.typeName}-стиля "${styleName}"`)
                    report.push({ kind:'warn', nodeName: node.name, nodeId: node.id, detail: `Нет маппинга для ${styleType.typeName}-стиля "${styleName}"` })
                  }
                }
              }
            }
          }
        }
        
        console.log(`Статистика обработки:`)
        console.log(`- Обработано стилей: ${processedStyles}`)
        console.log(`- Найдено маппингов: ${matchedStyles}`)
        console.log(`- Успешных замен: ${successfulReplacements}`)
        
        // Показываем результат в UI и уведомляем через notify
        if (successfulReplacements > 0) {
          figma.notify(`✅ Заменено ${successfulReplacements} из ${processedStyles} стилей на переменные`)
          figma.ui.postMessage({ 
            type: 'success', 
            detail: `Успешно заменено ${successfulReplacements} стилей на переменные. Обработано ${processedStyles} стилей, найдено ${matchedStyles} маппингов.` 
          })
        } else {
          figma.notify(`⚠️ Не удалось заменить ни одного стиля из ${processedStyles} найденных`)
          figma.ui.postMessage({ 
            type: 'warning', 
            detail: `Не удалось заменить ни одного стиля. Обработано ${processedStyles} стилей, найдено ${matchedStyles} маппингов.` 
          })
        }
}
async function collectionNameOf(v: Variable): Promise<string | undefined> {
  try {
    const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId)
    return col?.name
  } catch { return undefined }
}
function isColorVar(v: Variable): boolean {
  const t = (v as any).resolvedType || (v as any).type
  return t === 'COLOR'
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }
function bindVariableToPaints(node: any, variableId: string, prop: 'fills' | 'strokes', report: ReportItem[]): boolean {
  console.log(`Привязываем переменную ${variableId} к ${prop} узла ${node.name}`)
  if (!(prop in node)) {
    console.log(`Узел ${node.name} не имеет свойства ${prop}`)
    return false
  }
  const paints = clone(node[prop] as Paint[] | typeof figma.mixed)
  if (paints === figma.mixed) {
    console.log(`Смешанные ${prop} в узле ${node.name} — пропущено`)
    report.push({ kind:'warn', nodeName: node.name, nodeId: node.id, detail: `Смешанные ${prop} — пропущено` })
    return false
  }
  console.log(`Найдено ${paints.length} слоев в ${prop}`)
  let changed = false
  let solidLayers = 0
  for (const p of paints) {
    if (p.type === 'SOLID') {
      solidLayers++
      console.log(`Привязываем переменную к SOLID слою в ${prop}`)
      ;(p as any).boundVariables = (p as any).boundVariables || {}
      ;(p as any).boundVariables.color = { type: 'VARIABLE_ALIAS', id: variableId }
      changed = true
    }
  }
  console.log(`Найдено ${solidLayers} SOLID слоев из ${paints.length} общих`)
  if (changed) {
    node[prop] = paints
    console.log(`Успешно обновлен ${prop} узла ${node.name}`)
  } else {
    console.log(`Не удалось привязать переменную к ${prop} (нет SOLID слоёв)`)
    report.push({ kind:'warn', nodeName: node.name, nodeId: node.id, detail: `Не удалось привязать переменную к ${prop} (нет SOLID слоёв)` })
  }
  return changed
}
function bindVariableToEffects(node: any, variableId: string, report: ReportItem[]): boolean {
  if (!('effects' in node)) return false
  const effects = clone(node.effects as Effect[] | typeof figma.mixed)
  if (effects === figma.mixed) {
    report.push({ kind:'warn', nodeName: node.name, nodeId: node.id, detail:'Смешанные effects — пропущено' })
    return false
  }
  let changed = false
  for (const e of effects) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      ;(e as any).boundVariables = (e as any).boundVariables || {}
      ;(e as any).boundVariables.color = { type: 'VARIABLE_ALIAS', id: variableId }
      changed = true
    }
  }
  if (changed) node.effects = effects
  else report.push({ kind:'warn', nodeName: node.name, nodeId: node.id, detail:'Не удалось привязать переменную к эффектам (нет теней с цветом)' })
  return changed
}
async function makeReportFrame(items: ReportItem[]) {
  const page = figma.currentPage
  const frame = figma.createFrame()
  frame.name = 'Styles → Variables: отчёт'
  frame.x = 0; frame.y = 0
  frame.resizeWithoutConstraints(960, Math.max(200, 80 + items.length * 20))
  frame.fills = []
  try { await figma.loadFontAsync({ family:'Inter', style:'Regular' }) }
  catch { try { await figma.loadFontAsync({ family:'Roboto', style:'Regular' }) } catch {} }
  const text = figma.createText()
  text.name = 'Report'; text.x = 16; text.y = 16
  text.characters = formatReport(items)
  text.fontSize = 12
  text.lineHeight = { value: 16, unit: 'PIXELS' }
  text.textAutoResize = 'HEIGHT'
  text.resize(928, text.height)
  frame.appendChild(text)
  page.selection = [frame]
  page.appendChild(frame)
}
function formatReport(items: ReportItem[]): string {
  if (!items.length) return 'Готово. Все стили на текущей странице успешно заменены на переменные.'
  const lines: string[] = []
  lines.push(`Готово с предупреждениями/ошибками: ${items.length} пункт(ов).`,'')
  lines.push('Обработана только текущая страница.','')
  for (const it of items) {
    const node = it.nodeName ? ` [${it.nodeName}]` : ''
    lines.push(`${it.kind.toUpperCase()}: ${it.detail}${node}`)
  }
  return lines.join('\n')
}