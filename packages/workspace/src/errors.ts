import { isErrorCode, type ErrorCode } from "../../sdk/src/message";

/** A refusal or failure with one of the shared error codes (SPEC-02 §7). */
export class WorkspaceError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Turns anything thrown into a WorkspaceError: file system codes become shared codes. */
export function asWorkspaceError(error: unknown, signal?: AbortSignal): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted) return new WorkspaceError("cancelled", "The call was cancelled");
  switch (code) {
    case "ENOENT": return new WorkspaceError("not_found", message);
    case "ENOTDIR": case "EISDIR": case "EEXIST": return new WorkspaceError("bad_request", message);
    case "EACCES": case "EPERM": case "EROFS": return new WorkspaceError("forbidden", message);
    default: return new WorkspaceError(isErrorCode(code) ? code : "failed", message);
  }
}
