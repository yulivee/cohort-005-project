import { z } from "zod";

// A Note is plain text, trimmed, and capped on write. An over-long Note is
// refused, never truncated. An empty body clears the Note. Shared by the Lesson
// page action and the service.
export const MAX_NOTE_LENGTH = 2000;

export const noteBodySchema = z
  .string()
  .trim()
  .max(
    MAX_NOTE_LENGTH,
    `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters.`
  );
