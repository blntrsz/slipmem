import * as Schema from "effect/Schema";

export const SlipId = Schema.String.pipe(Schema.brand("SlipId"));
export type SlipId = typeof SlipId.Type;
