import { isErrorCode, WordError } from "../../sdk/src/message";

/** Turns anything thrown into a WordError: file system codes become shared codes. */
export function asWorkspaceError(error: unknown, signal?: AbortSignal): WordError {
  if (error instanceof WordError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted) return new WordError("cancelled", "The call was cancelled");
  switch (code) {
    case "ENOENT": return new WordError("not_found", message);
    case "ENOTDIR": case "EISDIR": case "EEXIST": return new WordError("bad_request", message);
    case "EACCES": case "EPERM": case "EROFS": return new WordError("forbidden", message);
    default: return new WordError(isErrorCode(code) ? code : "failed", message);
  }
}
