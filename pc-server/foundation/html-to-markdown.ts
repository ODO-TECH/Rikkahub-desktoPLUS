// foundation/html-to-markdown.ts — 无依赖的 HTML → 可读 Markdown 提取器
//
// 纪律：纯字符串进、纯字符串出，零运行时依赖（不碰 node/Bun API，web-ui 亦可在同源码复用）。
// 为什么不引第三方库：本仓的出站能力一律手写（MCP 客户端同为手搓 JSON-RPC），编译版单 exe
// 的体积与供应链面都要守住；而喂给模型的正文只需要"结构可读"，不需要渲染级保真。
//
// 与 foundation/utils.ts 的 stripHtml 分工：stripHtml 是"把标签去掉"的一行兜底；
// 本模块保留标题层级、列表、链接、代码块与表格——爬正文的质量直接决定模型能不能答对。

interface TextNode { type: "text"; text: string }
interface ElementNode { type: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
export type HtmlNode = TextNode | ElementNode

/** 自闭合标签：不入栈。 */
const VOID_TAGS = new Set([
  "area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input",
  "keygen", "link", "meta", "param", "source", "track", "wbr",
])

/** 内容不是标记的标签：一路跳到同名结束标签（<style> 里可以合法出现 `<`）。 */
const RAWTEXT_TAGS = new Set(["script", "style", "noscript", "template", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "svg"])

/** 整棵子树丢弃（对齐 Kelivo fetch 的清洗清单，另加 head/canvas/object）。 */
const DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
  "form", "nav", "aside", "footer", "head",
])

/** 块级标签：决定"新标签是否先闭合当前块"。 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "dt", "div", "dl",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
])

/** HTML 的隐式闭合：源文档里 `<p>1<p>2` 不写结束标签，必须按规则弹栈，否则整棵树塌陷。 */
function closesBefore(parentTag: string, nextTag: string): boolean {
  switch (parentTag) {
    case "p": return BLOCK_TAGS.has(nextTag) && nextTag !== "li"
    case "li": return nextTag === "li"
    case "dd": case "dt": return nextTag === "dd" || nextTag === "dt"
    // 单元格被下一个单元格或下一行闭合；行只被下一行/下一个表格分节闭合——
    // 若让 `<td>` 也闭合 `<tr>`，整行的单元格就全挂到 table 上，表格渲染成空壳。
    case "td": case "th": return nextTag === "td" || nextTag === "th" || nextTag === "tr"
    case "tr": return nextTag === "tr" || nextTag === "tbody" || nextTag === "tfoot" || nextTag === "thead"
    case "thead": case "tbody": return nextTag === "tfoot" || nextTag === "tbody" || nextTag === "thead"
    case "option": return nextTag === "option" || nextTag === "optgroup"
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return nextTag === "p"
    default: return false
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", bull: "•",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", dagger: "†", permil: "‰", larr: "←", rarr: "→", harr: "↔",
}

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});?/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return codePoint(code, match)
    }
    if (body.startsWith("#")) {
      return codePoint(Number.parseInt(body.slice(1), 10), match)
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

function codePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** 从 `<` 起读一个标签；引号内的 `>` 不算结束（`onclick="a>b"` 是真存在的脏 HTML）。 */
function readTag(html: string, start: number) {
  let i = start + 1
  const closing = html[i] === "/"
  if (closing) i += 1
  const nameStart = i
  while (i < html.length && /[a-zA-Z0-9_-]/.test(html[i])) i += 1
  if (i === nameStart && !closing) return null
  const name = html.slice(nameStart, i).toLowerCase()
  if (!name) return null
  const attrs: Record<string, string> = {}
  let selfClosing = false
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1
    if (i >= html.length) break
    if (html[i] === ">") { i += 1; break }
    if (html[i] === "/") {
      selfClosing = html[i + 1] === ">"
      i += selfClosing ? 2 : 1
      continue
    }
    const attrStart = i
    while (i < html.length && !/[\s=>/"'`]/.test(html[i])) i += 1
    const attrName = html.slice(attrStart, i).toLowerCase()
    let value = ""
    while (i < html.length && /\s/.test(html[i])) i += 1
    if (html[i] === "=") {
      i += 1
      while (i < html.length && /\s/.test(html[i])) i += 1
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        i += 1
        const valueStart = i
        while (i < html.length && html[i] !== quote) i += 1
        value = decodeEntities(html.slice(valueStart, i))
        i += 1
      } else {
        const valueStart = i
        while (i < html.length && !/[\s>]/.test(html[i])) i += 1
        value = decodeEntities(html.slice(valueStart, i))
      }
    }
    if (attrName) attrs[attrName] = value
  }
  return { name, attrs, closing, selfClosing, end: i }
}

export function parseHtml(html: string): { root: ElementNode; title: string } {
  const root: ElementNode = { type: "element", tag: "root", attrs: {}, children: [] }
  const stack: ElementNode[] = [root]
  let title = ""
  let pos = 0
  const top = () => stack[stack.length - 1]

  while (pos < html.length) {
    const lt = html.indexOf("<", pos)
    if (lt < 0) {
      pushText(top(), html.slice(pos))
      break
    }
    if (lt > pos) pushText(top(), html.slice(pos, lt))
    if (html.startsWith("<!--", lt)) {
      const commentEnd = html.indexOf("-->", lt + 4)
      pos = commentEnd < 0 ? html.length : commentEnd + 3
      continue
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const declEnd = html.indexOf(">", lt)
      pos = declEnd < 0 ? html.length : declEnd + 1
      continue
    }
    const tag = readTag(html, lt)
    if (!tag) {
      // 裸 `<`（比较符号、公式）当普通文本，别把它后面的内容吞掉。
      pushText(top(), "<")
      pos = lt + 1
      continue
    }
    pos = tag.end
    if (tag.name === "title" && !tag.closing) {
      const closeAt = findRawTextEnd(html, pos, tag.name)
      if (!title) title = collapseSpaces(decodeEntities(html.slice(pos, closeAt.contentEnd)))
      pos = closeAt.next
      continue
    }
    if (tag.closing) {
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === tag.name) {
          stack.length = depth
          break
        }
      }
      continue
    }
    while (stack.length > 1 && closesBefore(top().tag, tag.name)) stack.pop()
    // 丢弃型标签分两类：内容不是标记的（script/style/svg…）整段跳过；
    // 其余（nav/form/footer…）仍入栈当「垃圾桶」，让子树挂在它下面而不是泄漏到父层。
    if (DROP_TAGS.has(tag.name) && RAWTEXT_TAGS.has(tag.name)) {
      pos = findRawTextEnd(html, pos, tag.name).next
      continue
    }
    if (VOID_TAGS.has(tag.name) || tag.selfClosing) {
      top().children.push({ type: "element", tag: tag.name, attrs: tag.attrs, children: [] })
      continue
    }
    const element: ElementNode = { type: "element", tag: tag.name, attrs: tag.attrs, children: [] }
    top().children.push(element)
    stack.push(element)
    if (RAWTEXT_TAGS.has(tag.name)) {
      const raw = findRawTextEnd(html, pos, tag.name)
      element.children.push({ type: "text", text: decodeEntities(html.slice(pos, raw.contentEnd)) })
      pos = raw.next
    }
  }
  return { root, title }
}

function findRawTextEnd(html: string, from: number, name: string) {
  const lower = html.toLowerCase()
  const closeAt = lower.indexOf(`</${name}`, from)
  if (closeAt < 0) return { contentEnd: html.length, next: html.length }
  const gt = lower.indexOf(">", closeAt)
  return { contentEnd: closeAt, next: gt < 0 ? html.length : gt + 1 }
}

function pushText(parent: ElementNode, text: string) {
  if (!text) return
  const decoded = decodeEntities(text)
  if (!decoded) return
  const last = parent.children[parent.children.length - 1]
  if (last && last.type === "text") last.text += decoded
  else parent.children.push({ type: "text", text: decoded })
}

function collapseSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function textContentOf(node: HtmlNode): string {
  if (node.type === "text") return node.text
  return node.children.map(textContentOf).join("")
}

/** 绝对化链接：相对路径对模型没有价值，拼回原文档 origin 才能被再次 fetch。 */
function resolveUrl(value: string | undefined, baseUrl: string) {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:") || trimmed.startsWith("#") || /^mailto:/i.test(trimmed)) return trimmed
  try {
    return new URL(trimmed, baseUrl).href
  } catch {
    return trimmed
  }
}

interface RenderCtx {
  baseUrl: string
  listDepth: number
}

const INLINE_JOIN = new Set(["a", "abbr", "b", "code", "del", "em", "i", "ins", "mark", "s", "small", "span", "strong", "sub", "sup", "u"])

function render(node: HtmlNode, ctx: RenderCtx): string {
  if (node.type === "text") return node.text.replace(/\s+/g, " ")
  const { tag, attrs, children } = node
  if (DROP_TAGS.has(tag)) return ""
  const renderChildren = (nextCtx: RenderCtx = ctx) => children.map((child) => render(child, nextCtx)).join("")

  switch (tag) {
    case "br":
      return "\n"
    case "hr":
      return "\n\n---\n\n"
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const heading = collapseSpaces(renderChildren())
      if (!heading) return ""
      return `\n\n${"#".repeat(Number(tag[1]))} ${heading}\n\n`
    }
    case "a": {
      const href = resolveUrl(attrs.href, ctx.baseUrl)
      // 方括号会截断 [text](url) 语法，转义保留而非删除（引用标记 [1] 是有信息量的）。
      const label = collapseSpaces(renderChildren()).replace(/([\[\]])/g, "\\$1")
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return label
      if (!label) return href
      const target = href.includes(" ") || href.includes("(") ? `<${href}>` : href
      return `[${label}](${target})`
    }
    case "img": {
      const src = resolveUrl(attrs.src ?? attrs["data-src"], ctx.baseUrl)
      if (!src || src.startsWith("data:")) return ""
      const alt = collapseSpaces(attrs.alt ?? attrs.title ?? "").replace(/([\[\]])/g, "\\$1")
      return `![${alt}](${src})`
    }
    case "pre": {
      const code = textContentOf(node).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "")
      if (!code.trim()) return ""
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
    }
    case "code": {
      const inline = textContentOf(node).replace(/\s+/g, " ").trim()
      if (!inline) return ""
      const fence = inline.includes("`") ? "``" : "`"
      return `${fence}${inline}${fence}`
    }
    case "blockquote": {
      const quoted = normalizeMarkdown(renderChildren())
      if (!quoted) return ""
      return `\n\n${quoted.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`
    }
    case "ul": case "ol":
      return renderList(node, ctx)
    case "table":
      return renderTable(node, ctx)
    default: {
      const inner = renderChildren()
      if (INLINE_JOIN.has(tag)) return inner
      if (tag === "dt") return `\n\n${inner.trim()}\n\n`
      if (tag === "dd") return `\n\n: ${inner.trim()}\n\n`
      const isBlock = BLOCK_TAGS.has(tag)
      if (!isBlock && !hasBlockChild(children)) return inner
      return `\n\n${inner}\n\n`
    }
  }
}

function hasBlockChild(children: HtmlNode[]) {
  return children.some((child) => child.type === "element" && (BLOCK_TAGS.has(child.tag) || child.tag === "ul" || child.tag === "ol" || child.tag === "pre"))
}

function renderList(node: ElementNode, ctx: RenderCtx): string {
  const ordered = node.tag === "ol"
  const start = Number(node.attrs.start ?? "1")
  let index = Number.isFinite(start) && start > 0 ? start : 1
  const outerIndent = " ".repeat(ctx.listDepth * 2)
  const lines: string[] = []
  for (const child of node.children) {
    if (child.type !== "element") {
      const stray = collapseSpaces(render(child, ctx))
      if (stray) lines.push(`${outerIndent}${stray}`)
      continue
    }
    if (child.tag === "ul" || child.tag === "ol") {
      lines.push(normalizeMarkdown(renderList(child, { ...ctx, listDepth: ctx.listDepth + 1 })).split("\n").map((line) => (line ? `${outerIndent}${line}` : "")).join("\n"))
      continue
    }
    if (child.tag !== "li") {
      const stray = normalizeMarkdown(render(child, ctx))
      if (stray) lines.push(`${outerIndent}${stray}`)
      continue
    }
    const marker = ordered ? `${index++}. ` : "- "
    const own: string[] = []
    const nested: string[] = []
    for (const itemChild of child.children) {
      const isNestedList = itemChild.type === "element" && (itemChild.tag === "ul" || itemChild.tag === "ol")
      if (isNestedList) {
        nested.push(normalizeMarkdown(renderList(itemChild as ElementNode, { ...ctx, listDepth: ctx.listDepth + 1 })))
        continue
      }
      const piece = render(itemChild, { ...ctx, listDepth: ctx.listDepth })
      if (piece) own.push(piece)
    }
    const text = own.join(" ").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim()
    lines.push(`${outerIndent}${marker}${text}`)
    for (const block of nested) {
      for (const line of block.split("\n")) lines.push(line ? `${outerIndent}${line}` : "")
    }
  }
  return `\n\n${lines.join("\n")}\n\n`
}

function renderTable(node: ElementNode, ctx: RenderCtx): string {
  const rows: ElementNode[] = []
  const collect = (child: HtmlNode) => {
    if (child.type !== "element") return
    if (child.tag === "tr") rows.push(child)
    else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") child.children.forEach(collect)
  }
  node.children.forEach(collect)
  if (rows.length === 0) return ""
  const cellsOf = (row: ElementNode) =>
    row.children
      .filter((cell): cell is ElementNode => cell.type === "element" && (cell.tag === "td" || cell.tag === "th"))
      .map((cell) => collapseSpaces(render(cell, ctx)).replace(/\|/g, "\\|"))
  const parsed = rows.map(cellsOf)
  const columns = Math.max(...parsed.map((cells) => cells.length), 1)
  // GFM 要求首行是表头且分隔行与表头同宽；缺 thead 时把第一行当表头，仍是可读表格。
  const line = (cells: string[]) => `| ${cells.concat(Array.from({ length: columns - cells.length }, () => "")).join(" | ")} |`
  const lines = parsed.map(line)
  lines.splice(1, 0, `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`)
  return `\n\n${lines.join("\n")}\n\n`
}

function normalizeMarkdown(value: string) {
  // 只收拾「行尾空白 + 连续空行」。行首空格交给 trimBlankLines 处理，
  // 代码块与嵌套列表的缩进全靠它，用 String.trim() 会把 "  - 子项" 削成 "- 子项"。
  return trimBlankLines(value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"))
}

/** 只掐首尾空行，保留行内缩进（嵌套列表/代码块的层级信息在行首）。 */
function trimBlankLines(value: string) {
  const lines = value.split("\n")
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join("\n")
}

/** 正文优先取 main/article/role=main 的最长候选；过短（导航壳、空壳）回落整页。 */
function findMainContent(root: ElementNode): ElementNode {
  let best: ElementNode | null = null
  let bestLength = 0
  const walk = (node: ElementNode) => {
    for (const child of node.children) {
      if (child.type !== "element") continue
      const isCandidate = child.tag === "main" || child.tag === "article" || child.attrs.role === "main"
      if (isCandidate) {
        const length = textContentOf(child).length
        if (length > bestLength) {
          best = child
          bestLength = length
        }
      }
      walk(child)
    }
  }
  walk(root)
  return best && bestLength >= 200 ? best : root
}

/** 缺 `</body>` 的截断页很常见：深度优先找第一个 body，找不到就用整棵树。 */
function findBody(root: ElementNode): ElementNode | null {
  const queue: ElementNode[] = [root]
  while (queue.length > 0) {
    const node = queue.shift() as ElementNode
    if (node.tag === "body") return node
    for (const child of node.children) if (child.type === "element") queue.push(child)
  }
  return null
}

export interface ReadableHtml {
  title: string
  markdown: string
}

/** HTML → { title, markdown }。baseUrl 用于把相对链接/图片绝对化。 */
export function htmlToReadable(html: string, baseUrl = ""): ReadableHtml {
  const { root, title } = parseHtml(html)
  const body = findBody(root) ?? root
  const ctx: RenderCtx = { baseUrl, listDepth: 0 }
  const candidate = findMainContent(body)
  let markdown = normalizeMarkdown(render(candidate, ctx))
  if (markdown.length < 200 && candidate !== body) markdown = normalizeMarkdown(render(body, ctx))
  if (!markdown) markdown = normalizeMarkdown(collapseSpaces(textContentOf(root)))
  return {
    title: title || collapseSpaces(firstHeading(body)),
    markdown,
  }
}

export function htmlToMarkdown(html: string, baseUrl = "") {
  return htmlToReadable(html, baseUrl).markdown
}

function firstHeading(body: ElementNode): string {
  let found = ""
  const walk = (node: ElementNode) => {
    if (found) return
    for (const child of node.children) {
      if (child.type !== "element") continue
      if (/^h[12]$/.test(child.tag)) {
        found = textContentOf(child)
        return
      }
      walk(child)
      if (found) return
    }
  }
  walk(body)
  return found
}
