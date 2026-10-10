/** What the owner hears when a turn that was answering them fails: the likely cause in plain words, never the provider's raw payload. */

/** The option id of the retry button on the failure card. */
export const RETRY_OPTION = "retry";

export function failureCause(error: string | null | undefined): string {
  const text = String(error ?? "");
  if (/agent process ended|process exited|process failed|stdin failed/i.test(text)) return "负责思考的进程中途退出了";
  if (/invalid JSON|tool input/i.test(text)) return "模型这次给出的操作指令格式坏了";
  if (/no model key/i.test(text)) return "还没有填模型的 Key（设置 → 密钥）";
  if (/\b(401|403)\b|auth|api.?key|unauthori[sz]ed|forbidden/i.test(text)) return "模型那边没认我的 Key";
  if (/\b402\b|balance|insufficient|quota/i.test(text)) return "模型账户余额不足";
  if (/\b429\b|rate.?limit/i.test(text)) return "模型那边在限流";
  if (/time.?out|timed out|ETIMEDOUT|deadline/i.test(text)) return "等模型回应超时了";
  if (/\b5\d\d\b|overloaded|server error|bad gateway/i.test(text)) return "模型服务那边暂时出错了";
  if (/network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|offline|unreachable|socket|model call failed/i.test(text)) return "连不上模型";
  return "出了点意外的错误";
}

export const failureText = (error: string | null | undefined): string => `刚才这件事没做成：${failureCause(error)}。`;
