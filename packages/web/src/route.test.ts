import { expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"

import {
  deleteNoteHref,
  editNoteHref,
  homeRouter,
  newNoteHref,
  noteHref,
  searchHref,
  urlToAppRoute,
  wikiHref,
} from "./route"

const parse = (value: string) => {
  const url = Option.getOrThrow(fromString(`http://localhost${value}`))
  return urlToAppRoute(url)
}

const noteId = "20261117193045-agent-memory-is-bounded"

test("note detail, edit, and delete are distinct ID-based routes", () => {
  expect(parse(`/notes/${noteId}`)).toMatchObject({
    _tag: "NoteDetail",
    noteId,
  })
  expect(parse(`/notes/${noteId}/edit`)).toMatchObject({
    _tag: "EditNote",
    noteId,
  })
  expect(parse(`/notes/${noteId}/delete`)).toMatchObject({
    _tag: "DeleteNote",
    noteId,
  })
  expect(parse("/notes")).toMatchObject({ _tag: "NotFound" })
})

test("list, search, tags, wiki, review, and health routes decode their queries", () => {
  expect(parse("/?type=permanent&tag=agent-memory")).toMatchObject({
    _tag: "Home",
    type: Option.some("permanent"),
    tag: Option.some("agent-memory"),
  })
  expect(parse("/new?type=literature")).toMatchObject({
    _tag: "NewNote",
    type: Option.some("literature"),
  })
  expect(parse("/search?q=bounded+recall&type=permanent")).toMatchObject({
    _tag: "Search",
    q: Option.some("bounded recall"),
    type: Option.some("permanent"),
  })
  expect(parse("/tags")).toMatchObject({ _tag: "Tags" })
  expect(parse("/wiki/agent-memory?mode=synthesized")).toMatchObject({
    _tag: "Wiki",
    tag: "agent-memory",
    mode: Option.some("synthesized"),
  })
  expect(parse("/wiki/agent-memory?includeFleeting=true")).toMatchObject({
    _tag: "Wiki",
    tag: "agent-memory",
    includeFleeting: Option.some("true"),
  })
  expect(parse("/review")).toMatchObject({ _tag: "Review" })
  expect(parse("/health")).toMatchObject({ _tag: "Health" })
  expect(parse("/no/such/path")).toMatchObject({
    _tag: "NotFound",
    path: "no/such/path",
  })
})

test("href builders round-trip through the route parser", () => {
  const hrefs = [
    homeRouter({ type: Option.some("fleeting"), tag: Option.none() }),
    newNoteHref("permanent"),
    noteHref(noteId),
    editNoteHref(noteId),
    deleteNoteHref(noteId),
    searchHref("bounded recall"),
    "/tags",
    wikiHref("agent-memory", { mode: "extractive" }),
    wikiHref("agent-memory", { includeFleeting: true }),
    "/review",
    "/health",
  ]

  for (const href of hrefs) {
    const parsed = parse(href)
    expect(parsed._tag).not.toBe("NotFound")
  }
})
