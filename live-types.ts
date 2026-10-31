export type LiveKind = "user" | "assistant" | "thinking" | "tool" | "command" | "stdout" | "stderr" | "system";

/** A safe, structured view of one retained log entry. Text is never HTML. */
export interface LiveEntry {
  id: string;
  at: number | null;
  kind: LiveKind;
  text: string;
  tool?: string;
  command?: string;
  status?: string;
  exitCode?: number | null;
  /** A streamed delta for the entry with this id, not a new snapshot. */
  append?: boolean;
}
