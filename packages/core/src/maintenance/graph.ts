import { Markdown } from "@slipmem/schemas/markdown"
import { Effect } from "effect"
import { extractInternalMarkdownLinks } from "../markdown/check.js"
import type { ParsedMarkdownNote } from "../markdown/note-document.js"
import type { MarkdownError } from "../markdown/errors.js"
import type { MarkdownNoteRepositoryShape } from "../markdown/repository.js"
import {
  MAINTENANCE_PROVENANCE_SOURCE,
  MAINTENANCE_RELATION_KINDS,
  MAX_MAINTENANCE_RELATIONS,
  managedPermanentMetadata,
  readMaintenanceMetadata,
  type MaintenanceSourceRef,
} from "./metadata.js"

/**
 * Derivation edges are automatic. `supersedes` and `contradicts` are durable,
 * worker-validated plans. `implements` is read-only here and belongs to nearby
 * tooling. `link` is the pre-existing Markdown link graph: it is projected on
 * demand and is always disposable because it carries no version evidence.
 */
export const MAINTENANCE_GRAPH_EDGE_KINDS = [
  "derived_from",
  ...MAINTENANCE_RELATION_KINDS,
  "link",
] as const

export type MaintenanceGraphEdgeKind =
  (typeof MAINTENANCE_GRAPH_EDGE_KINDS)[number]

export type MaintenanceGraphEdgeStatus = "current" | "stale" | "missing"

export interface MaintenanceGraphNode {
  readonly id: string
  readonly type: Markdown.NoteType
  readonly title: string
  readonly contentHash: string
  readonly updatedAt: string
  /** True only while the note's maintenance state hash still matches. */
  readonly managed: boolean
}

export interface MaintenanceGraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: MaintenanceGraphEdgeKind
  readonly status: MaintenanceGraphEdgeStatus
  /**
   * The target hash recorded with the relation. `null` for a disposable
   * Markdown link, which was never version-pinned.
   */
  readonly recordedTargetHash: string | null
  /** The target file hash in this projection, or `null` when missing. */
  readonly currentTargetHash: string | null
  /** Source revisions that justify a typed relation; empty for links. */
  readonly evidence: ReadonlyArray<MaintenanceSourceRef>
  /**
   * Links come from note bodies, not from a validated plan. They can be stale
   * or missing without invalidating the note that contains them.
   */
  readonly disposable: boolean
}

export interface MaintenanceGraph {
  readonly nodes: ReadonlyArray<MaintenanceGraphNode>
  readonly edges: ReadonlyArray<MaintenanceGraphEdge>
}

export const DEFAULT_GRAPH_QUERY_LIMIT = 100
export const MAX_GRAPH_QUERY_LIMIT = 500
/** Body links are bounded per note so one note cannot explode the projection. */
export const MAX_GRAPH_LINKS_PER_NOTE = 64

/**
 * An all-zero hash is used by fixtures and early hand-written metadata as a
 * placeholder, not as a computed ownership claim. It is the only marker value
 * that cannot be checked against a managed state.
 */
const PLACEHOLDER_STATE_HASH = "0".repeat(64)

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const targetStatus = (
  target: ParsedMarkdownNote | undefined,
  recordedTargetHash: string,
): MaintenanceGraphEdgeStatus =>
  target === undefined
    ? "missing"
    : target.contentHash === recordedTargetHash
      ? "current"
      : "stale"

/**
 * A typed relation is current only while both the target and every evidence
 * revision still match their recorded hashes. A changed or deleted evidence
 * source makes the claim unverifiable even if the target itself is unchanged.
 */
const relationStatus = (
  target: ParsedMarkdownNote | undefined,
  recordedTargetHash: string,
  evidence: ReadonlyArray<MaintenanceSourceRef>,
  byId: ReadonlyMap<string, ParsedMarkdownNote>,
): MaintenanceGraphEdgeStatus => {
  const targetState = targetStatus(target, recordedTargetHash)
  if (targetState !== "current") {
    return targetState
  }
  for (const source of evidence) {
    const current = byId.get(source.id)
    if (current === undefined || current.contentHash !== source.contentHash) {
      return "stale"
    }
  }
  return "current"
}

const edgeKey = (edge: {
  readonly from: string
  readonly to: string
  readonly kind: MaintenanceGraphEdgeKind
}): string => `${edge.from}\u0000${edge.kind}\u0000${edge.to}`

/**
 * Projects a typed, version-aware graph from the durable note artifacts.
 *
 * Nothing is persisted: a rebuild is a fresh scan of the same notes. The
 * projection never repairs, renames, links, or rewrites a note, and an edge is
 * informational rather than a permission or a trust upgrade. `implements`
 * relations written by another owner are preserved and shown but are never
 * generated here.
 */
export const projectMaintenanceGraph = (
  notes: ReadonlyArray<ParsedMarkdownNote>,
): MaintenanceGraph => {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const nodes = notes
    .map(
      (note): MaintenanceGraphNode => ({
        id: note.id,
        type: note.metadata.type,
        title: note.metadata.title,
        contentHash: note.contentHash,
        updatedAt: note.metadata.updatedAt,
        managed: managedPermanentMetadata(note) !== null,
      }),
    )
    .sort((left, right) => compareText(left.id, right.id))

  const edges: MaintenanceGraphEdge[] = []
  const seen = new Set<string>()

  const addEdge = (edge: MaintenanceGraphEdge): void => {
    if (edge.from === edge.to) {
      return
    }
    const key = edgeKey(edge)
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    edges.push(edge)
  }

  for (const note of notes) {
    const metadata = readMaintenanceMetadata(note)
    // A marker that no longer matches its managed state was hand-edited. Its
    // typed assertions are historical, not current, even when every target
    // and evidence hash still matches. This check is graph-only: recall keeps
    // treating such a note as a factual human-edited permanent.
    const ownerStateApplies =
      metadata !== null &&
      (note.metadata.provenance?.source === MAINTENANCE_PROVENANCE_SOURCE ||
        metadata.stateHash !== PLACEHOLDER_STATE_HASH)
    const ownerManaged =
      metadata !== null && managedPermanentMetadata(note) !== null
    const ownerStatus = (
      status: MaintenanceGraphEdgeStatus,
    ): MaintenanceGraphEdgeStatus =>
      ownerStateApplies && !ownerManaged && status !== "missing"
        ? "stale"
        : status

    // Version 1 markers and version 2 markers both project their tracked
    // source revisions as automatic `derived_from` evidence.
    for (const source of metadata?.sources ?? []) {
      const target = byId.get(source.id)
      addEdge({
        from: note.id,
        to: source.id,
        kind: "derived_from",
        status: ownerStatus(targetStatus(target, source.contentHash)),
        recordedTargetHash: source.contentHash,
        currentTargetHash: target?.contentHash ?? null,
        evidence: [source],
        disposable: false,
      })
    }

    const relations = metadata?.relations ?? []
    for (const relation of relations.slice(0, MAX_MAINTENANCE_RELATIONS)) {
      const target = byId.get(relation.target)
      addEdge({
        from: note.id,
        to: relation.target,
        kind: relation.kind,
        status: ownerStatus(
          relationStatus(
            target,
            relation.targetHash,
            relation.evidence,
            byId,
          ),
        ),
        recordedTargetHash: relation.targetHash,
        currentTargetHash: target?.contentHash ?? null,
        evidence: relation.evidence,
        // `implements` is durable too; it is simply written by another owner.
        disposable: false,
      })
    }

    // The old Markdown link index remains useful, but it is untyped and not
    // version-pinned. It stays visibly disposable and is never promoted.
    const linked = new Set<string>()
    let linkCount = 0
    for (const link of extractInternalMarkdownLinks(note.body)) {
      if (link.status !== "candidate" || linkCount >= MAX_GRAPH_LINKS_PER_NOTE) {
        continue
      }
      const id = link.target.endsWith(".md")
        ? link.target.slice(0, -".md".length)
        : link.target
      if (!Markdown.isNoteId(id) || id === note.id || linked.has(id)) {
        continue
      }
      linked.add(id)
      linkCount++
      const target = byId.get(id)
      addEdge({
        from: note.id,
        to: id,
        kind: "link",
        status: target === undefined ? "missing" : "current",
        recordedTargetHash: null,
        currentTargetHash: target?.contentHash ?? null,
        evidence: [],
        disposable: true,
      })
    }
  }

  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.kind, right.kind) ||
      compareText(left.to, right.to),
  )

  return { nodes, edges }
}

/** Reads and projects the graph. The projection is always safe to rebuild. */
export const readMaintenanceGraph = (
  repository: Pick<MarkdownNoteRepositoryShape, "scan">,
): Effect.Effect<MaintenanceGraph, MarkdownError> =>
  repository.scan().pipe(Effect.map((scan) => projectMaintenanceGraph(scan.notes)))

export interface MaintenanceGraphQuery {
  /** Constrains one endpoint according to `direction`. */
  readonly noteId?: string
  readonly direction?: "outgoing" | "incoming" | "both"
  /** Absolute source/target filters, applied in addition to `noteId`. */
  readonly from?: string
  readonly to?: string
  readonly kind?: MaintenanceGraphEdgeKind
  readonly status?: MaintenanceGraphEdgeStatus
  /** Include the disposable Markdown link graph. Defaults to true. */
  readonly includeDisposable?: boolean
  readonly limit?: number
}

const boundedLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_GRAPH_QUERY_LIMIT
  }
  return Math.max(1, Math.min(MAX_GRAPH_QUERY_LIMIT, Math.trunc(value)))
}

/** Bounded, deterministic graph query. It never reads outside the projection. */
export const queryMaintenanceGraph = (
  graph: MaintenanceGraph,
  query: MaintenanceGraphQuery = {},
): ReadonlyArray<MaintenanceGraphEdge> => {
  const direction = query.direction ?? "both"
  const includeDisposable = query.includeDisposable ?? true
  const results: MaintenanceGraphEdge[] = []

  for (const edge of graph.edges) {
    if (!includeDisposable && edge.disposable) {
      continue
    }
    if (query.kind !== undefined && edge.kind !== query.kind) {
      continue
    }
    if (query.status !== undefined && edge.status !== query.status) {
      continue
    }
    if (query.from !== undefined && edge.from !== query.from) {
      continue
    }
    if (query.to !== undefined && edge.to !== query.to) {
      continue
    }
    if (query.noteId !== undefined) {
      const outgoing = edge.from === query.noteId
      const incoming = edge.to === query.noteId
      if (
        (direction === "outgoing" && !outgoing) ||
        (direction === "incoming" && !incoming) ||
        (direction === "both" && !outgoing && !incoming)
      ) {
        continue
      }
    }
    results.push(edge)
    if (results.length >= boundedLimit(query.limit)) {
      break
    }
  }

  return results
}

export interface MaintenanceNoteGraphView {
  readonly note: MaintenanceGraphNode | undefined
  readonly outgoing: ReadonlyArray<MaintenanceGraphEdge>
  readonly incoming: ReadonlyArray<MaintenanceGraphEdge>
  /** Outgoing typed edges whose target moved or disappeared. */
  readonly invalidated: ReadonlyArray<MaintenanceGraphEdge>
}

export const maintenanceGraphForNote = (
  graph: MaintenanceGraph,
  id: string,
  options: { readonly includeDisposable?: boolean } = {},
): MaintenanceNoteGraphView => {
  const includeDisposable = options.includeDisposable ?? true
  const visible = (edge: MaintenanceGraphEdge): boolean =>
    includeDisposable || !edge.disposable
  const outgoing = graph.edges.filter(
    (edge) => edge.from === id && visible(edge),
  )
  const incoming = graph.edges.filter(
    (edge) => edge.to === id && visible(edge),
  )
  return {
    note: graph.nodes.find((node) => node.id === id),
    outgoing,
    incoming,
    invalidated: outgoing.filter(
      (edge) => !edge.disposable && edge.status !== "current",
    ),
  }
}

/**
 * All typed edges that no longer match the current target version. Callers can
 * surface these as stale memory instead of treating old evidence as current.
 */
export const invalidatedMaintenanceEdges = (
  graph: MaintenanceGraph,
): ReadonlyArray<MaintenanceGraphEdge> =>
  graph.edges.filter(
    (edge) => !edge.disposable && edge.status !== "current",
  )
