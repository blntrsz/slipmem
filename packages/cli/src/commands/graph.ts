import {
  DEFAULT_GRAPH_QUERY_LIMIT,
  MAINTENANCE_GRAPH_EDGE_KINDS,
  MAX_GRAPH_QUERY_LIMIT,
  maintenanceGraphForNote,
  markdownError,
  queryMaintenanceGraph,
  readMaintenanceGraph,
  type MaintenanceGraph,
  type MaintenanceGraphEdge,
  type MaintenanceGraphEdgeKind,
  type MaintenanceGraphEdgeStatus,
  type MaintenanceGraphNode,
} from "@slipmem/core"
import { Effect } from "effect"
import { join } from "node:path"
import { booleanOption, numberOption, stringOption } from "../args.js"
import { openRepository, resolveRoot } from "../context.js"
import { usageError } from "../errors.js"
import { parseLimit } from "../note-values.js"
import { plural, writeJson, writeLine } from "../output.js"
import type { CommandDefinition } from "./command.js"

const GRAPH_EDGE_STATUSES = ["current", "stale", "missing"] as const

type GraphDirection = "outgoing" | "incoming" | "both"

const parseDirection = (
  value: string | undefined,
): GraphDirection | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value === "outgoing" || value === "incoming" || value === "both") {
    return value
  }
  throw usageError(
    "--direction must be outgoing, incoming, or both.",
    "graph",
  )
}

const parseEdgeKind = (
  value: string | undefined,
): MaintenanceGraphEdgeKind | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (
    (MAINTENANCE_GRAPH_EDGE_KINDS as ReadonlyArray<string>).includes(value)
  ) {
    return value as MaintenanceGraphEdgeKind
  }
  throw usageError(
    `--kind must be one of ${MAINTENANCE_GRAPH_EDGE_KINDS.join(", ")}, not '${value}'.`,
    "graph",
  )
}

const parseEdgeStatus = (
  value: string | undefined,
): MaintenanceGraphEdgeStatus | undefined => {
  if (value === undefined) {
    return undefined
  }
  if ((GRAPH_EDGE_STATUSES as ReadonlyArray<string>).includes(value)) {
    return value as MaintenanceGraphEdgeStatus
  }
  throw usageError(
    `--status must be one of ${GRAPH_EDGE_STATUSES.join(", ")}, not '${value}'.`,
    "graph",
  )
}

const noteIdFrom = (
  positionals: ReadonlyArray<string>,
): string | undefined => {
  const value = positionals[0]
  if (value === undefined) {
    return undefined
  }
  const id = value.trim()
  if (id.length === 0) {
    throw usageError("graph accepts a non-empty note ID.", "graph")
  }
  return id
}

const idOption = (
  value: string | undefined,
  name: "from" | "to",
): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const id = value.trim()
  if (id.length === 0) {
    throw usageError(`--${name} requires a non-empty note ID.`, "graph")
  }
  return id
}

const incidentNodes = (
  graph: MaintenanceGraph,
  edges: ReadonlyArray<MaintenanceGraphEdge>,
): ReadonlyArray<MaintenanceGraphNode> => {
  const ids = new Set<string>()
  for (const edge of edges) {
    ids.add(edge.from)
    ids.add(edge.to)
  }
  return graph.nodes.filter((node) => ids.has(node.id))
}

const renderEdge = (edge: MaintenanceGraphEdge): string =>
  `${edge.from} -> ${edge.to}  [${edge.kind}, ${edge.status}]${
    edge.disposable ? " (disposable)" : ""
  }`

const renderOutgoing = (edge: MaintenanceGraphEdge): string =>
  `  -> ${edge.to}  [${edge.kind}, ${edge.status}]${
    edge.disposable ? " (disposable)" : ""
  }`

const renderIncoming = (edge: MaintenanceGraphEdge): string =>
  `  <- ${edge.from}  [${edge.kind}, ${edge.status}]${
    edge.disposable ? " (disposable)" : ""
  }`

export const graphCommand: CommandDefinition = {
  name: "graph",
  summary: "Show the read-only, version-aware note relationship graph",
  usage:
    "graph [<note-id>] [--direction outgoing|incoming|both] [--from <id>] [--to <id>] [--kind <kind>] [--status current|stale|missing] [--no-links] [--limit <n>] [--json]",
  details: [
    "Projects typed maintenance relations and their recorded target hashes from",
    "note metadata, then adds the disposable Markdown link graph. Nothing is",
    "written, repaired, or promoted to trusted knowledge.",
    "Without a note ID, matching edges are listed within the shared bound. With",
    "a note ID, its outgoing, incoming, and invalidated typed edges are shown.",
    "status stale or missing means the recorded target version no longer matches.",
    "JSON nodes are bounded to the endpoints of the selected edges.",
  ],
  options: {
    direction: { type: "string", valueName: "outgoing|incoming|both" },
    from: { type: "string", valueName: "id" },
    to: { type: "string", valueName: "id" },
    kind: { type: "string", valueName: "kind" },
    status: { type: "string", valueName: "current|stale|missing" },
    "no-links": { type: "boolean" },
    limit: { type: "number", valueName: "n" },
  },
  maxPositionals: 1,
  run: (parsed, context) =>
    Effect.gen(function* () {
      const noteId = noteIdFrom(parsed.positionals)
      const direction = parseDirection(stringOption(parsed, "direction"))
      const from = idOption(stringOption(parsed, "from"), "from")
      const to = idOption(stringOption(parsed, "to"), "to")
      const kind = parseEdgeKind(stringOption(parsed, "kind"))
      const status = parseEdgeStatus(stringOption(parsed, "status"))
      const includeDisposable = !booleanOption(parsed, "no-links")
      const limit = parseLimit(numberOption(parsed, "limit"), {
        command: "graph",
        fallback: DEFAULT_GRAPH_QUERY_LIMIT,
        maximum: MAX_GRAPH_QUERY_LIMIT,
      })

      if (direction !== undefined && noteId === undefined) {
        throw usageError(
          "--direction requires a note ID; without one the graph lists all matching edges.",
          "graph",
        )
      }

      const resolved = yield* resolveRoot(context, stringOption(parsed, "dir"))
      const repository = yield* openRepository(context, resolved.root)
      const graph = yield* readMaintenanceGraph(repository)
      const filters = {
        direction: noteId === undefined ? null : (direction ?? "both"),
        from: from ?? null,
        to: to ?? null,
        kind: kind ?? null,
        status: status ?? null,
        includeLinks: includeDisposable,
        limit,
      }

      if (noteId !== undefined) {
        const view = maintenanceGraphForNote(graph, noteId, {
          includeDisposable,
        })
        if (view.note === undefined) {
          return yield* Effect.fail(
            markdownError({
              area: "repository",
              code: "not-found",
              path: join(resolved.root, `${noteId}.md`),
              message: `Note '${noteId}' was not found in ${resolved.root}; the graph never invents a node.`,
            }),
          )
        }

        const selected = queryMaintenanceGraph(graph, {
          noteId,
          direction: direction ?? "both",
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(kind === undefined ? {} : { kind }),
          ...(status === undefined ? {} : { status }),
          includeDisposable,
          limit,
        })
        const outgoing = selected.filter((edge) => edge.from === noteId)
        const incoming = selected.filter((edge) => edge.to === noteId)

        if (parsed.options.json === true) {
          writeJson(context.io, {
            ok: true,
            root: resolved.root,
            noteCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            note: view.note,
            count: selected.length,
            filters,
            outgoing,
            incoming,
            invalidated: view.invalidated,
          })
        } else {
          writeLine(
            context.io,
            `${view.note.id}  [${view.note.type}]  ${view.note.title}`,
          )
          writeLine(
            context.io,
            `  updated: ${view.note.updatedAt}  managed: ${view.note.managed ? "yes" : "no"}  hash: ${view.note.contentHash}`,
          )
          writeLine(
            context.io,
            `  graph: ${plural(graph.nodes.length, "note")}, ${plural(graph.edges.length, "edge")}; showing ${selected.length} matching ${plural(selected.length, "edge")}`,
          )

          if (direction !== "incoming" && outgoing.length > 0) {
            writeLine(context.io, "\nOutgoing:")
            for (const edge of outgoing) {
              writeLine(context.io, renderOutgoing(edge))
            }
          }
          if (direction !== "outgoing" && incoming.length > 0) {
            writeLine(context.io, "\nIncoming:")
            for (const edge of incoming) {
              writeLine(context.io, renderIncoming(edge))
            }
          }
          if (direction !== "incoming" && view.invalidated.length > 0) {
            writeLine(context.io, "\nInvalidated typed edges:")
            for (const edge of view.invalidated) {
              writeLine(context.io, renderOutgoing(edge))
            }
          }
          if (
            selected.length === 0 &&
            (direction === "incoming" || view.invalidated.length === 0)
          ) {
            writeLine(context.io, "\nNo matching edges.")
          }
        }

        return 0
      }

      const selected = queryMaintenanceGraph(graph, {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
        includeDisposable,
        limit,
      })
      const nodes = incidentNodes(graph, selected)

      if (parsed.options.json === true) {
        writeJson(context.io, {
          ok: true,
          root: resolved.root,
          noteCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          count: selected.length,
          filters,
          nodes,
          edges: selected,
        })
      } else {
        writeLine(
          context.io,
          `Graph: ${plural(graph.nodes.length, "note")}, ${plural(graph.edges.length, "edge")}`,
        )
        if (selected.length === 0) {
          writeLine(context.io, "No matching edges.")
        } else {
          writeLine(
            context.io,
            `Showing ${selected.length} matching ${plural(selected.length, "edge")}:\n`,
          )
          for (const edge of selected) {
            writeLine(context.io, renderEdge(edge))
          }
        }
      }

      return 0
    }),
}
