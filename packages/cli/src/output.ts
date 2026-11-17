export interface CliIo {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
}

export const writeJson = (io: CliIo, value: unknown): void => {
  io.out(`${JSON.stringify(value, null, 2)}\n`)
}

export const writeLine = (io: Pick<CliIo, "out">, text = ""): void => {
  io.out(`${text}\n`)
}

export const writeErrorLine = (io: CliIo, text: string): void => {
  io.err(`${text}\n`)
}

/** Keeps table output readable without truncating an ID or a whole title. */
export const pad = (value: string, width: number): string =>
  value.length >= width ? value : value.padEnd(width)

export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`
