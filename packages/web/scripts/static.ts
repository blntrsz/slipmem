import { resolve } from "node:path"

/**
 * Resolves a built client asset URL below the static directory, or returns
 * `undefined` when the request must fall through to the application handler.
 *
 * Malformed percent escapes and NUL bytes are treated as non-assets rather than
 * throwing: a bad static URL must not turn into a server error. Decoding before
 * the root check also keeps encoded `..` traversal from escaping the directory.
 */
export const staticAssetPath = (
  clientDirectory: string,
  requestUrl: string,
): string | undefined => {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname)
  } catch {
    return undefined
  }

  if (
    pathname === "/" ||
    pathname.endsWith("/index.html") ||
    pathname.includes("\0")
  ) {
    return undefined
  }

  const root = resolve(clientDirectory)
  const filePath = resolve(root, `.${pathname}`)
  return filePath.startsWith(`${root}/`) ? filePath : undefined
}
