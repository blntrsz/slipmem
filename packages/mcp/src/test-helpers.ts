import {
  initializeNoteRoot,
  makeMarkdownNoteRepository,
  type CreateMarkdownNoteInput,
  type MarkdownNoteRepositoryShape,
  type ParsedMarkdownNote,
} from "@slipmem/core"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface DisposableRoot {
  readonly directory: string
  readonly root: string
  readonly cacheDir: string
}

export const makeDisposableRoot = async (): Promise<DisposableRoot> => {
  const directory = await mkdtemp(join(tmpdir(), "slipmem-mcp-"))
  const root = join(directory, ".slipmem")
  const cacheDir = join(directory, "cache")
  await Effect.runPromise(initializeNoteRoot(root))
  return { directory, root, cacheDir }
}

export const removeDisposableRoot = async (disposable: DisposableRoot) => {
  await rm(disposable.directory, { recursive: true, force: true })
}

export const makeTestClock = (start = Date.UTC(2026, 10, 17, 12, 0, 0)) => {
  let current = start
  return {
    now: () => current,
    advance: (milliseconds = 1000) => {
      current += milliseconds
      return current
    },
  }
}

export const withRepository = async <A>(
  root: string,
  now: () => number,
  run: (repository: MarkdownNoteRepositoryShape) => Promise<A>,
): Promise<A> => {
  const repository = await Effect.runPromise(makeMarkdownNoteRepository({ root, now }))
  return run(repository)
}

export const createTestNote = async (
  root: string,
  input: CreateMarkdownNoteInput,
  now: () => number,
): Promise<ParsedMarkdownNote> => {
  const repository = await Effect.runPromise(makeMarkdownNoteRepository({ root, now }))
  return Effect.runPromise(repository.create(input))
}
