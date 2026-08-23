import { z } from "zod";

export interface JobCursor {
  rank: number;
  priority: number;
  // Display value only; comparisons use the lossless microsecond key.
  createdAt: string;
  // Epoch microseconds as decimal text: Postgres timestamptz is exact here,
  // while JS Date/ISO would truncate sub-millisecond digits.
  createdAtUs: string;
  id: string;
}

const envelopeSchema = z.object({
  v: z.literal(2),
  r: z.number().int().min(0).max(2),
  p: z.number().int().min(0).max(9),
  c: z.string().datetime(),
  m: z.string().regex(/^\d{1,17}$/),
  i: z.string().uuid(),
});

export const jobRank = (state: string): number => {
  if (state === "BLOCKED") return 0;
  if (state === "IN_PROGRESS") return 1;
  return 2;
};

export function encodeJobCursor(cursor: JobCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      r: cursor.rank,
      p: cursor.priority,
      c: cursor.createdAt,
      m: cursor.createdAtUs,
      i: cursor.id,
    }),
  ).toString("base64url");
}

export function decodeJobCursor(value: string): JobCursor | null {
  try {
    const parsed = envelopeSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (!parsed.success) return null;
    return {
      rank: parsed.data.r,
      priority: parsed.data.p,
      createdAt: parsed.data.c,
      createdAtUs: parsed.data.m,
      id: parsed.data.i,
    };
  } catch {
    return null;
  }
}
