import { Option, Schema, pipe } from "effect"
import { Route } from "foldkit"
import { defineRouteUnion, literal, restString, slash, string } from "foldkit/route"

/**
 * The Foldkit route union for the local web UI.
 *
 * Detail, edit, and delete are separate routes so the browser can bookmark a
 * note and the delete action always passes through an explicit confirmation
 * page. Note order is by ID, never by array position.
 */
export const AppRoute = defineRouteUnion({
  Home: {
    type: Schema.OptionFromOptional(Schema.String),
    topic: Schema.OptionFromOptional(Schema.String),
  },
  NewNote: { type: Schema.OptionFromOptional(Schema.String) },
  NoteDetail: { noteId: Schema.String },
  EditNote: { noteId: Schema.String },
  DeleteNote: { noteId: Schema.String },
  Search: {
    q: Schema.OptionFromOptional(Schema.String),
    type: Schema.OptionFromOptional(Schema.String),
  },
  Topics: {},
  Wiki: {
    topic: Schema.String,
    mode: Schema.OptionFromOptional(Schema.String),
    includeFleeting: Schema.OptionFromOptional(Schema.String),
  },
  Review: {},
  Health: {},
  NotFound: { path: Schema.String },
})

export type AppRoute = typeof AppRoute.Type

const homeQuery = Schema.Struct({
  type: Schema.OptionFromOptional(Schema.String),
  topic: Schema.OptionFromOptional(Schema.String),
})

export const homeRouter = pipe(
  Route.root,
  Route.query(homeQuery),
  Route.mapTo(AppRoute.Home),
)

export const newNoteRouter = pipe(
  literal("new"),
  Route.query(
    Schema.Struct({
      type: Schema.OptionFromOptional(Schema.String),
    }),
  ),
  Route.mapTo(AppRoute.NewNote),
)

export const noteDetailRouter = pipe(
  literal("notes"),
  slash(string("noteId")),
  Route.mapTo(AppRoute.NoteDetail),
)

export const editNoteRouter = pipe(
  literal("notes"),
  slash(string("noteId")),
  slash(literal("edit")),
  Route.mapTo(AppRoute.EditNote),
)

export const deleteNoteRouter = pipe(
  literal("notes"),
  slash(string("noteId")),
  slash(literal("delete")),
  Route.mapTo(AppRoute.DeleteNote),
)

export const searchRouter = pipe(
  literal("search"),
  Route.query(
    Schema.Struct({
      q: Schema.OptionFromOptional(Schema.String),
      type: Schema.OptionFromOptional(Schema.String),
    }),
  ),
  Route.mapTo(AppRoute.Search),
)

export const topicsRouter = pipe(literal("topics"), Route.mapTo(AppRoute.Topics))

export const wikiRouter = pipe(
  literal("wiki"),
  slash(string("topic")),
  Route.query(
    Schema.Struct({
      mode: Schema.OptionFromOptional(Schema.String),
      includeFleeting: Schema.OptionFromOptional(Schema.String),
    }),
  ),
  Route.mapTo(AppRoute.Wiki),
)

export const reviewRouter = pipe(literal("review"), Route.mapTo(AppRoute.Review))

export const healthRouter = pipe(literal("health"), Route.mapTo(AppRoute.Health))

const notFoundRouter = pipe(restString("path"), Route.mapTo(AppRoute.NotFound))

const routeParser = Route.oneOf(
  editNoteRouter,
  deleteNoteRouter,
  noteDetailRouter,
  newNoteRouter,
  searchRouter,
  topicsRouter,
  wikiRouter,
  reviewRouter,
  healthRouter,
  homeRouter,
  notFoundRouter,
)

export const urlToAppRoute = Route.parseUrlWithFallback(
  routeParser,
  AppRoute.NotFound,
)

export const noteHref = (noteId: string): string =>
  noteDetailRouter({ noteId })

export const editNoteHref = (noteId: string): string =>
  editNoteRouter({ noteId })

export const deleteNoteHref = (noteId: string): string =>
  deleteNoteRouter({ noteId })

export const newNoteHref = (type?: string): string =>
  newNoteRouter({ type: Option.fromNullishOr(type) })

export const searchHref = (q: string, type?: string): string =>
  searchRouter({
    q: Option.some(q),
    type: Option.fromNullishOr(type),
  })

export const wikiHref = (
  topic: string,
  options: {
    readonly mode?: string
    readonly includeFleeting?: boolean
  } = {},
): string =>
  wikiRouter({
    topic,
    mode: Option.fromNullishOr(options.mode),
    includeFleeting:
      options.includeFleeting === true ? Option.some("true") : Option.none(),
  })
