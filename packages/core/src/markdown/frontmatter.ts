import { Effect } from "effect"
import {
  isCollection,
  isMap,
  isScalar,
  parseDocument,
  stringify,
  type Node,
} from "yaml"
import { Markdown } from "@slipmem/schemas/markdown"
import { MarkdownError, markdownError } from "./errors.js"

// Frontmatter is deliberately small. A bounded document prevents alias
// expansion and parser work from growing with attacker-controlled input even
// before the 1 MiB whole-file limit is applied.
export const MAX_FRONTMATTER_BYTES = 64 * 1024
export const MAX_YAML_ALIASES = 32

const FRONTMATTER_DELIMITER = "---"

export interface NoteFrontmatter {
  readonly data: Readonly<Record<string, unknown>>
  /** Body without the separator blank line and without trailing whitespace. */
  readonly body: string
}

const frontmatterError = (
  path: string,
  code: "frontmatter-missing" | "malformed-yaml" | "executable-yaml" | "frontmatter-too-large",
  message: string,
  field?: string,
): MarkdownError =>
  markdownError({
    area: "frontmatter",
    code,
    path,
    message,
    ...(field === undefined ? {} : { field }),
  })

const isDelimiter = (line: string): boolean =>
  line.trimEnd() === FRONTMATTER_DELIMITER

/**
 * Splits a note into YAML frontmatter and body.
 *
 * The split is line based so a `---` inside the body (for example a horizontal
 * rule) never terminates the frontmatter a second time. The body is trimmed at
 * the edges: the blank separator line after the closing delimiter is formatting,
 * not note content.
 */
export const splitNoteDocument = (
  path: string,
  content: string,
): Effect.Effect<NoteFrontmatter, MarkdownError> =>
  Effect.gen(function* () {
    const lines = content.split(/\r?\n/)

    if (lines.length === 0 || !isDelimiter(lines[0] ?? "")) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "frontmatter-missing",
          "A note must start with a YAML frontmatter block delimited by '---'.",
        ),
      )
    }

    const closing = lines.findIndex(
      (line, index) => index > 0 && isDelimiter(line),
    )
    if (closing < 0) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          "The YAML frontmatter block never closes with '---'.",
        ),
      )
    }

    const yamlText = lines.slice(1, closing).join("\n")
    const body = lines
      .slice(closing + 1)
      .join("\n")
      .trim()

    if (Buffer.byteLength(yamlText, "utf8") > MAX_FRONTMATTER_BYTES) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "frontmatter-too-large",
          `Frontmatter must be ${MAX_FRONTMATTER_BYTES} bytes or fewer.`,
        ),
      )
    }

    const document = parseDocument(yamlText, {
      schema: "core",
      uniqueKeys: true,
      prettyErrors: true,
    })

    if (document.errors.length > 0) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          document.errors[0]!.message,
        ),
      )
    }

    const unsafeTag = findUnsafeTag(document.contents)
    if (unsafeTag !== null) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "executable-yaml",
          `YAML tag '${unsafeTag}' is not allowed in note frontmatter.`,
        ),
      )
    }

    if (!isMap(document.contents)) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          "Note frontmatter must be a YAML mapping.",
        ),
      )
    }

    let data: unknown
    try {
      data = document.toJS({ maxAliasCount: MAX_YAML_ALIASES })
    } catch (cause) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          cause instanceof Error ? cause.message : "Frontmatter could not be decoded.",
        ),
      )
    }

    if (!isPlainRecord(data)) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          "Note frontmatter must decode to a plain mapping.",
        ),
      )
    }

    const unsafeKey = findUnsafeDataKey(data)
    if (unsafeKey !== null) {
      return yield* Effect.fail(
        frontmatterError(
          path,
          "malformed-yaml",
          `Frontmatter key '${unsafeKey}' is not allowed.`,
          unsafeKey,
        ),
      )
    }

    return { data, body }
  })

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isUnsafeKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor" || key === "prototype"

const findUnsafeDataKey = (
  value: unknown,
  seen: Set<object> = new Set(),
): string | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnsafeDataKey(item, seen)
      if (found !== null) {
        return found
      }
    }
    return null
  }

  if (!isPlainRecord(value)) {
    return null
  }
  if (seen.has(value)) {
    // `toJS` does not produce cycles, but guarding here keeps this helper safe
    // if it is reused on caller-supplied objects.
    return null
  }
  seen.add(value)

  for (const [key, item] of Object.entries(value)) {
    if (isUnsafeKey(key)) {
      return key
    }
    const found = findUnsafeDataKey(item, seen)
    if (found !== null) {
      return found
    }
  }

  return null
}

// Standard YAML 1.2 core/scalar tags are data. Everything else - including
// `!!python/...`, `!ruby/object`, and local tags - is rejected before `toJS` so
// no constructor or resolver can be reached. `yaml` never executes tags, but
// rejecting them makes the storage contract explicit.
const SAFE_TAGS = new Set([
  "tag:yaml.org,2002:binary",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:merge",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:omap",
  "tag:yaml.org,2002:pairs",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:set",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:timestamp",
])

const findUnsafeTag = (node: Node | null | undefined): string | null => {
  if (node === null || node === undefined) {
    return null
  }

  if (typeof (node as { tag?: unknown }).tag === "string") {
    const tag = (node as { tag: string }).tag
    if (!SAFE_TAGS.has(tag)) {
      return tag
    }
  }

  if (!isCollection(node)) {
    return null
  }

  for (const item of node.items) {
    if (isScalar(item)) {
      const nested = findUnsafeTag(item)
      if (nested !== null) {
        return nested
      }
      continue
    }

    if (isMap(item) || isCollection(item)) {
      const nested = findUnsafeTag(item as Node)
      if (nested !== null) {
        return nested
      }
      continue
    }

    // Map pairs are plain objects with `key` and `value` nodes.
    const pair = item as { key?: Node | null; value?: Node | null }
    const keyTag = findUnsafeTag(pair.key)
    if (keyTag !== null) {
      return keyTag
    }
    const valueTag = findUnsafeTag(pair.value)
    if (valueTag !== null) {
      return valueTag
    }
  }

  return null
}

const KNOWN_KEYS = new Set([
  "schema",
  "id",
  "type",
  "title",
  "createdAt",
  "updatedAt",
  "topics",
  "reference",
  "provenance",
  "legacyId",
  "aliases",
])

export const splitUnknownMetadata = (
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const unknown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) {
      unknown[key] = value
    }
  }

  return unknown
}

export interface RenderNoteDocumentInput {
  readonly metadata: Markdown.NoteMetadata
  readonly body: string
  readonly unknown?: Readonly<Record<string, unknown>>
}

/**
 * Renders metadata and a body into canonical note Markdown.
 *
 * Known fields are emitted in a fixed order and timestamps are double quoted so
 * another YAML reader cannot turn them into dates. Unknown keys follow in their
 * original order, which preserves manual metadata across a read/write cycle.
 */
export const renderNoteDocument = ({
  metadata,
  body,
  unknown = {},
}: RenderNoteDocumentInput): string => {
  const frontmatter: Record<string, unknown> = {
    schema: metadata.schema,
    id: metadata.id,
    type: metadata.type,
    title: metadata.title,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  }

  if (metadata.topics !== undefined && metadata.topics.length > 0) {
    frontmatter.topics = metadata.topics
  }
  if (metadata.reference !== undefined && metadata.reference.trim() !== "") {
    frontmatter.reference = metadata.reference
  }
  if (metadata.provenance !== undefined) {
    frontmatter.provenance = metadata.provenance
  }
  if (metadata.legacyId !== undefined) {
    frontmatter.legacyId = metadata.legacyId
  }
  if (metadata.aliases !== undefined && metadata.aliases.length > 0) {
    frontmatter.aliases = metadata.aliases
  }

  for (const [key, value] of Object.entries(unknown)) {
    if (!KNOWN_KEYS.has(key)) {
      frontmatter[key] = value
    }
  }

  const document = parseDocument("", { schema: "core" })
  const node = document.createNode(frontmatter) as Node
  quoteTimestampKeys(node)
  const yamlText = stringify(node, { schema: "core", lineWidth: 0 }).trimEnd()
  const normalizedBody = body.trim()

  return `---\n${yamlText}\n---\n\n${normalizedBody}\n`
}

const quoteTimestampKeys = (node: Node): void => {
  if (!isMap(node)) {
    return
  }

  for (const pair of node.items) {
    if (!isScalar(pair.key)) {
      continue
    }

    const key = pair.key.value
    if (
      (key === "createdAt" || key === "updatedAt") &&
      isScalar(pair.value)
    ) {
      pair.value.type = "QUOTE_DOUBLE"
    }
  }
}

/**
 * Parses a YAML document for tests and tools that already separated it.
 * The public note parser should be preferred because it also validates the
 * filename and known fields.
 */
export const parseFrontmatterYaml = (
  path: string,
  yamlText: string,
): Effect.Effect<Readonly<Record<string, unknown>>, MarkdownError> =>
  splitNoteDocument(path, `---\n${yamlText}\n---\n`).pipe(
    Effect.map((frontmatter) => frontmatter.data),
  )
