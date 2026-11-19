import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { resolve } from "node:path"
import { MarkdownError } from "./errors.js"
import { scanMarkdownRoot, type RepositoryScan } from "./repository.js"

export type CheckSeverity = "error" | "warning"

export interface NoteCheckIssue {
  readonly severity: CheckSeverity
  readonly area: MarkdownError["area"]
  readonly code: string
  readonly path: string
  readonly field?: string
  readonly message: string
}

export interface IndexFingerprint {
  readonly id: string
  readonly contentHash: string
}

export interface CheckNoteRootOptions {
  /**
   * Optional index snapshot. Supplying it enables drift checks without making
   * `check` depend on opening SQLite; a rebuild is always the recovery path.
   */
  readonly index?: ReadonlyArray<IndexFingerprint>
}

export interface NoteBacklink {
  /** Stable note ID that is the target of one or more internal links. */
  readonly id: string
  /** Source note IDs, sorted. Self-links are not counted as backlinks. */
  readonly sources: ReadonlyArray<string>
}

export interface NoteCheckReport {
  readonly root: string
  readonly ok: boolean
  readonly noteCount: number
  readonly scannedFiles: number
  readonly issues: ReadonlyArray<NoteCheckIssue>
  readonly warnings: ReadonlyArray<NoteCheckIssue>
  readonly notes: ReadonlyArray<{
    readonly id: string
    readonly path: string
    readonly type: Markdown.NoteType
    readonly title: string
  }>
  readonly index: {
    readonly checked: boolean
    readonly drift: number
  }
  /**
   * Link validation is derived from note bodies on every check. It is not
   * persisted: the disposable index does not yet expose a backlink table.
   */
  readonly links: {
    /** Internal wikilinks and direct `.md` links evaluated. */
    readonly checked: number
    /** References that were malformed, unsafe, or missing a target note. */
    readonly broken: number
    readonly backlinks: ReadonlyArray<NoteBacklink>
  }
}

const fromError = (error: MarkdownError): NoteCheckIssue => ({
  severity: "error",
  area: error.area,
  code: error.code,
  path: error.path,
  ...(error.field === undefined ? {} : { field: error.field }),
  message: error.message,
})

const warning = (
  code: string,
  path: string,
  message: string,
  field?: string,
): NoteCheckIssue => ({
  severity: "warning",
  area: "repository",
  code,
  path,
  ...(field === undefined ? {} : { field }),
  message,
})

export type MarkdownLinkKind = "wikilink" | "markdown"

export interface MarkdownLinkReference {
  readonly kind: MarkdownLinkKind
  /** One-based source line in the note body. */
  readonly line: number
  /** The link as written, including brackets and destination. */
  readonly raw: string
  /** Decoded target with any fragment or query removed. */
  readonly target: string
  /**
   * `candidate` is a structurally valid note reference that still has to be
   * matched against the root's IDs. `unsafe` means traversal, an absolute
   * path, or separator injection. `malformed` is an empty wikilink target.
   */
  readonly status: "candidate" | "unsafe" | "malformed"
}

type InternalLinkResolution =
  | {
      readonly status: "candidate"
      readonly target: string
      readonly id: string
    }
  | { readonly status: "unsafe"; readonly target: string }
  | { readonly status: "malformed"; readonly target: string }

const isEscaped = (text: string, index: number): boolean => {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

const lineNumberAt = (text: string, index: number): number => {
  let line = 1
  for (let cursor = 0; cursor < index; cursor++) {
    if (text[cursor] === "\n") {
      line++
    }
  }
  return line
}

const maskLine = (line: string): string => " ".repeat(line.length)

/**
 * Masks fenced code blocks so examples of links are not validated as links.
 * Newlines and offsets are preserved so diagnostics still report real lines.
 */
const maskFencedCode = (text: string): string => {
  const lines = text.split("\n")
  let fence: { readonly character: string; readonly length: number } | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (fence === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      const marker = opening?.[1]
      if (marker !== undefined && !(marker[0] === "`" && opening![2]!.includes("`"))) {
        fence = { character: marker[0]!, length: marker.length }
        lines[index] = maskLine(line)
      }
      continue
    }

    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
    const marker = closing?.[1]
    if (
      marker !== undefined &&
      marker[0] === fence.character &&
      marker.length >= fence.length
    ) {
      fence = null
    }
    lines[index] = maskLine(line)
  }

  return lines.join("\n")
}

/** Masks inline code spans and HTML comments, preserving line offsets. */
const maskInlineCodeAndComments = (text: string): string => {
  const characters = text.split("")

  const mask = (start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      if (characters[index] !== "\n") {
        characters[index] = " "
      }
    }
  }

  let index = 0
  while (index < characters.length) {
    if (
      index + 3 < characters.length &&
      characters[index] === "<" &&
      characters[index + 1] === "!" &&
      characters[index + 2] === "-" &&
      characters[index + 3] === "-"
    ) {
      let cursor = index + 4
      while (
        cursor + 2 < characters.length &&
        !(
          characters[cursor] === "-" &&
          characters[cursor + 1] === "-" &&
          characters[cursor + 2] === ">"
        )
      ) {
        cursor++
      }
      const end =
        cursor + 2 < characters.length ? cursor + 3 : characters.length
      mask(index, end)
      index = end
      continue
    }

    if (characters[index] !== "`" || isEscaped(text, index)) {
      index++
      continue
    }

    let runEnd = index
    while (runEnd < characters.length && characters[runEnd] === "`") {
      runEnd++
    }
    const runLength = runEnd - index
    let cursor = runEnd
    let closed = false

    while (cursor < characters.length) {
      if (characters[cursor] !== "`") {
        cursor++
        continue
      }
      let candidateEnd = cursor
      while (
        candidateEnd < characters.length &&
        characters[candidateEnd] === "`"
      ) {
        candidateEnd++
      }
      if (candidateEnd - cursor === runLength) {
        mask(index, candidateEnd)
        index = candidateEnd
        closed = true
        break
      }
      cursor = candidateEnd
    }

    if (!closed) {
      index = runEnd
    }
  }

  return characters.join("")
}

const maskCode = (body: string): string =>
  maskInlineCodeAndComments(maskFencedCode(body))

const decodeReference = (value: string): string => {
  let decoded = value
  // Decode at most twice so double-encoded traversal is still visible without
  // ever letting a malformed escape throw.
  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) {
        break
      }
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

const unescapeMarkdown = (value: string): string =>
  value.replace(/\\([\\`*_{}()#+\-.!|>~]|\[|\])/g, "$1")

const unsafeWikilinkTarget = (target: string): boolean =>
  target === "." ||
  target === ".." ||
  target.startsWith("/") ||
  target.startsWith("\\") ||
  /^[A-Za-z]:/.test(target) ||
  /[\\/]/.test(target)

const resolveWikilink = (
  content: string,
): InternalLinkResolution | "ignore" => {
  const alias = content.indexOf("|")
  const reference = (alias === -1 ? content : content.slice(0, alias)).trim()
  const fragment = reference.indexOf("#")
  const target = decodeReference(
    (fragment === -1 ? reference : reference.slice(0, fragment)).trim(),
  ).trim()

  if (target === "") {
    // [[#heading]] is a same-note anchor, not an unresolved note link.
    return fragment === -1 ? { status: "malformed", target } : "ignore"
  }

  if (unsafeWikilinkTarget(target)) {
    return { status: "unsafe", target }
  }

  const id = target.endsWith(".md") ? target.slice(0, -".md".length) : target
  return { status: "candidate", target, id }
}

const resolveMarkdownDestination = (
  destination: string,
): InternalLinkResolution | "ignore" => {
  const unescaped = unescapeMarkdown(destination.trim())
  if (unescaped === "") {
    return "ignore"
  }

  // Same-note anchors and query-only links never name another note.
  if (unescaped.startsWith("#") || unescaped.startsWith("?")) {
    return "ignore"
  }

  if (/^[A-Za-z]:[\\/]/.test(unescaped) || unescaped.startsWith("\\\\")) {
    return { status: "unsafe", target: unescaped }
  }

  const decoded = decodeReference(unescaped)

  // Any URI scheme (https, mailto, data, file, ...) is an external reference.
  // Note content is data: check must not reinterpret remote URLs as local
  // files, even when they end in ".md".
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
    return "ignore"
  }
  if (decoded.startsWith("//")) {
    return "ignore"
  }

  const fragment = decoded.indexOf("#")
  const withoutFragment =
    fragment === -1 ? decoded : decoded.slice(0, fragment)
  const query = withoutFragment.indexOf("?")
  const path = (
    query === -1 ? withoutFragment : withoutFragment.slice(0, query)
  ).trim()

  if (path === "" || !path.endsWith(".md")) {
    return "ignore"
  }

  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.split("").some((character) => character.charCodeAt(0) < 32)
  ) {
    return { status: "unsafe", target: path }
  }

  const segments = path.split("/")
  if (segments.some((segment) => segment === "..")) {
    return { status: "unsafe", target: path }
  }
  const parts = segments[0] === "." ? segments.slice(1) : segments
  // Note files are direct children of the flat root. A nested path is either a
  // mistake or an attempt to escape the link namespace.
  if (
    parts.length !== 1 ||
    parts[0] === undefined ||
    parts[0] === "" ||
    parts[0] === "." ||
    parts[0] === ".."
  ) {
    return { status: "unsafe", target: path }
  }

  const filename = parts[0]
  return {
    status: "candidate",
    target: filename,
    id: filename.slice(0, -".md".length),
  }
}

const findClosingBracket = (text: string, open: number): number => {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const character = text[index]
    if (isEscaped(text, index)) {
      continue
    }
    if (character === "[") {
      depth++
    } else if (character === "]") {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

interface ParsedDestination {
  readonly target: string
  readonly end: number
}

/**
 * Parses the destination of an inline Markdown link after `(`. Bounded by the
 * note size; returns null when the link has no properly closed destination.
 */
const parseLinkDestination = (
  text: string,
  openParen: number,
): ParsedDestination | null => {
  let index = openParen + 1
  while (index < text.length && /\s/.test(text[index]!)) {
    index++
  }

  let target = ""
  if (text[index] === "<") {
    index++
    const start = index
    while (index < text.length && text[index] !== ">") {
      index += isEscaped(text, index) ? 2 : 1
    }
    if (index >= text.length) {
      return null
    }
    target = text.slice(start, index)
    index++
  } else {
    const start = index
    let depth = 0
    while (index < text.length) {
      const character = text[index]!
      if (isEscaped(text, index)) {
        index += 2
        continue
      }
      if (/\s/.test(character) && depth === 0) {
        break
      }
      if (character === "(") {
        depth++
      } else if (character === ")") {
        if (depth === 0) {
          break
        }
        depth--
      }
      index++
    }
    target = text.slice(start, index)
  }

  let depth = 0
  while (index < text.length) {
    const character = text[index]!
    if (isEscaped(text, index)) {
      index += 2
      continue
    }
    if (character === "(") {
      depth++
    } else if (character === ")") {
      if (depth === 0) {
        return { target, end: index + 1 }
      }
      depth--
    }
    index++
  }
  return null
}

/**
 * Extracts internal wikilinks and direct `.md` links from a note body.
 *
 * Fenced code, inline code, HTML comments, and backslash-escaped links are
 * ignored. External URLs, same-note anchors (`#heading`, `[[#heading]]`), and
 * non-Markdown relative links are not local note references and are omitted.
 * Returned references still need to be matched against the root's note IDs;
 * `status` distinguishes malformed and unsafe destinations from candidates.
 */
export const extractInternalMarkdownLinks = (
  body: string,
): ReadonlyArray<MarkdownLinkReference> => {
  const masked = maskCode(body)
  const links: MarkdownLinkReference[] = []

  const wikilink = /!?\[\[([^[\]\n]*)\]\]/g
  for (const match of masked.matchAll(wikilink)) {
    const offset = match.index
    if (offset === undefined || isEscaped(masked, offset)) {
      continue
    }
    const resolved = resolveWikilink(match[1]!)
    if (resolved === "ignore") {
      continue
    }
    links.push({
      kind: "wikilink",
      line: lineNumberAt(body, offset),
      raw: body.slice(offset, offset + match[0].length),
      target: resolved.target,
      status: resolved.status,
    })
  }

  for (let index = 0; index < masked.length; index++) {
    if (masked[index] !== "[" || isEscaped(masked, index)) {
      continue
    }
    // Image destinations are assets, not note links.
    if (
      index > 0 &&
      body[index - 1] === "!" &&
      !isEscaped(masked, index - 1)
    ) {
      continue
    }
    const close = findClosingBracket(masked, index)
    if (close === -1 || masked[close + 1] !== "(") {
      continue
    }
    const parsed = parseLinkDestination(masked, close + 1)
    if (parsed === null) {
      continue
    }
    const resolved = resolveMarkdownDestination(parsed.target)
    if (resolved !== "ignore") {
      links.push({
        kind: "markdown",
        line: lineNumberAt(body, index),
        raw: body.slice(index, parsed.end),
        target: resolved.target,
        status: resolved.status,
      })
    }
    index = parsed.end - 1
  }

  // CommonMark reference definitions are also direct note-file links:
  //   [ref]: 20261117193045-note.md
  // The usage (`[text][ref]`) is intentionally not resolved; the definition
  // carries the actual destination and is validated once.
  const definition =
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm
  for (const match of masked.matchAll(definition)) {
    const offset = match.index
    if (offset === undefined) {
      continue
    }
    const destination = match[2] ?? match[3] ?? ""
    const resolved = resolveMarkdownDestination(destination)
    if (resolved !== "ignore") {
      links.push({
        kind: "markdown",
        line: lineNumberAt(body, offset),
        raw: body.slice(offset, offset + match[0].length),
        target: resolved.target,
        status: resolved.status,
      })
    }
  }

  return links.sort((left, right) => left.line - right.line)
}

const linkExcerpt = (raw: string): string =>
  raw.length <= 160 ? raw : `${raw.slice(0, 157)}...`

const linkIssue = (
  code: "broken-link" | "unsafe-link" | "malformed-link",
  path: string,
  line: number,
  message: string,
): NoteCheckIssue => ({
  severity: "error",
  area: "body",
  code,
  path,
  field: "body",
  message: `${message} (line ${line})`,
})

interface LinkCheckResult {
  readonly issues: ReadonlyArray<NoteCheckIssue>
  readonly checked: number
  readonly broken: number
  readonly backlinks: ReadonlyArray<NoteBacklink>
}

const checkNoteLinks = (
  notes: ReadonlyArray<{
    readonly id: string
    readonly path: string
    readonly body: string
  }>,
): LinkCheckResult => {
  const noteIds = new Set(notes.map((note) => note.id))
  const issues: NoteCheckIssue[] = []
  const reverse = new Map<string, Set<string>>()
  let checked = 0
  let broken = 0

  for (const note of notes) {
    for (const link of extractInternalMarkdownLinks(note.body)) {
      checked++
      const excerpt = linkExcerpt(link.raw)

      if (link.status === "malformed") {
        broken++
        issues.push(
          linkIssue(
            "malformed-link",
            note.path,
            link.line,
            `Malformed internal wikilink '${excerpt}': the target is empty. Use [[note-id]] or [[#heading]].`,
          ),
        )
        continue
      }

      if (link.status === "unsafe") {
        broken++
        issues.push(
          linkIssue(
            "unsafe-link",
            note.path,
            link.line,
            `Unsafe internal link '${excerpt}' targets '${link.target}'. Internal links must be a direct note ID or a direct .md filename in the flat root; traversal, absolute paths, and separator injection are rejected.`,
          ),
        )
        continue
      }

      const id = link.kind === "wikilink"
        ? link.target.endsWith(".md")
          ? link.target.slice(0, -".md".length)
          : link.target
        : link.target.slice(0, -".md".length)

      if (!noteIds.has(id)) {
        broken++
        issues.push(
          linkIssue(
            "broken-link",
            note.path,
            link.line,
            `Broken internal link '${excerpt}': no note with ID '${id}' exists in the note root.`,
          ),
        )
        continue
      }

      if (id !== note.id) {
        const sources = reverse.get(id) ?? new Set<string>()
        sources.add(note.id)
        reverse.set(id, sources)
      }
    }
  }

  const backlinks = [...reverse.entries()]
    .map(([id, sources]) => ({ id, sources: [...sources].sort() }))
    .sort((left, right) => (left.id < right.id ? -1 : 1))

  return { issues, checked, broken, backlinks }
}

const collisionSuffix = /-\d+$/

/**
 * The filename slug is the title slug at creation time, optionally followed by
 * a collision suffix. Compare the exact slug first: stripping a trailing number
 * unconditionally would report false drift for a title such as "Agent memory 2"
 * whose own slug legitimately ends in `-2`.
 */
const slugMatchesTitle = (title: string, id: string): boolean => {
  const slug = Markdown.noteSlugFromId(id)
  const expected = Markdown.slugifyTitle(title)
  if (slug === expected) {
    return true
  }

  const collision = collisionSuffix.exec(slug)
  return (
    collision !== null && slug.slice(0, collision.index) === expected
  )
}

const buildReport = (
  root: string,
  scan: RepositoryScan,
  options: CheckNoteRootOptions,
): NoteCheckReport => {
  const issues: NoteCheckIssue[] = scan.invalid.map(fromError)
  const warnings: NoteCheckIssue[] = []

  for (const entry of scan.unexpected) {
    warnings.push(
      warning(
        entry.isNoteFilename ? "unexpected-entry" : "unexpected-file",
        entry.path,
        entry.isNoteFilename
          ? "A note filename must be a regular file, not a directory or special entry."
          : "This file is not a note and is ignored by the index.",
      ),
    )
  }

  const seen = new Map<string, string>()
  for (const note of scan.notes) {
    const previous = seen.get(note.id)
    if (previous !== undefined) {
      issues.push({
        severity: "error",
        area: "filename",
        code: "duplicate-id",
        path: note.path,
        message: `Duplicate note ID '${note.id}' also appears at ${previous}.`,
      })
    } else {
      seen.set(note.id, note.path)
    }

    if (!slugMatchesTitle(note.metadata.title, note.id)) {
      warnings.push(
        warning(
          "slug-drift",
          note.path,
          "The filename slug no longer matches the title. This is allowed; renaming is opt-in and not performed by check.",
          "title",
        ),
      )
    }
  }

  const links = checkNoteLinks(scan.notes)
  issues.push(...links.issues)

  let drift = 0
  if (options.index !== undefined) {
    const indexed = new Map(options.index.map((entry) => [entry.id, entry.contentHash]))
    for (const note of scan.notes) {
      const hash = indexed.get(note.id)
      if (hash === undefined) {
        drift++
        warnings.push(
          warning(
            "index-missing",
            note.path,
            "The note is not in the derived index. Run 'slipmem check --rebuild-index'.",
          ),
        )
      } else if (hash !== note.contentHash) {
        drift++
        warnings.push(
          warning(
            "index-stale",
            note.path,
            "The derived index has an older content hash. Refresh or rebuild the index.",
          ),
        )
      }
      indexed.delete(note.id)
    }

    for (const [id] of indexed) {
      drift++
      warnings.push(
        warning(
          "index-extra",
          root,
          `The derived index contains stale note id '${id}' that no longer exists. Rebuild the index.`,
        ),
      )
    }
  }

  return {
    root,
    ok: issues.length === 0,
    noteCount: scan.notes.length,
    scannedFiles:
      scan.notes.length + scan.invalid.length + scan.unexpected.length,
    issues,
    warnings,
    notes: scan.notes.map((note) => ({
      id: note.id,
      path: note.path,
      type: note.metadata.type,
      title: note.metadata.title,
    })),
    index: { checked: options.index !== undefined, drift },
    links: {
      checked: links.checked,
      broken: links.broken,
      backlinks: links.backlinks,
    },
  }
}

/**
 * Read-only repository health check. It never repairs, renames, or writes.
 * Errors are contract violations; warnings include non-note files, slug drift,
 * and recoverable index drift.
 */
export const checkNoteRoot = (
  root: string,
  options: CheckNoteRootOptions = {},
): Effect.Effect<NoteCheckReport, never> =>
  Effect.gen(function* () {
    const absoluteRoot = resolve(root)
    const scan = yield* scanMarkdownRoot(absoluteRoot).pipe(
      Effect.match({
        onFailure: (error) => ({ error, scan: null }),
        onSuccess: (result) => ({ error: null, scan: result }),
      }),
    )

    if (scan.error !== null) {
      return {
        root: absoluteRoot,
        ok: false,
        noteCount: 0,
        scannedFiles: 0,
        issues: [fromError(scan.error)],
        warnings: [],
        notes: [],
        index: { checked: false, drift: 0 },
        links: { checked: 0, broken: 0, backlinks: [] },
      }
    }

    return buildReport(absoluteRoot, scan.scan!, options)
  })

/** Builds the drift input from an index snapshot without importing SQLite. */
export const indexFingerprints = (
  snapshot: ReadonlyArray<{ readonly id: string; readonly contentHash: string }>,
): ReadonlyArray<IndexFingerprint> =>
  snapshot.map(({ id, contentHash }) => ({ id, contentHash }))
