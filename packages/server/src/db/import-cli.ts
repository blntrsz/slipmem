import { readFileSync } from "node:fs";
import { defaultFilename, open } from "./database.ts";
import { importDomainObjects, parseNdjson } from "./import.ts";

const input = process.argv[2];
if (input === undefined) {
  console.error("Usage: bun run import:postgres <domain-objects.ndjson>");
  process.exit(1);
}

const filename = process.env.SLIPMEM_SQLITE_PATH ?? defaultFilename();
const rows = parseNdjson(readFileSync(input, "utf8"));
const database = open({ filename });
const imported = importDomainObjects(database.db, rows, { prefix: "SlipMem." });
database.sqlite.close();

console.log(`Imported ${imported} Domain rows into ${filename}.`);
