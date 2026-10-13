/** Fetch one known inline attachment only when opened; the raw message never enters the display store. */
export async function readInlineAttachment(net, item, messageId, index) {
  if (!item || item.id !== messageId || !item.attachments?.some(attachment => attachment.source === "inline" && attachment.index === index)) return null;
  const page = await net.data("service:history", "read", { from_seq: item.seq, to_seq: item.seq });
  const message = page.messages?.find(row => row.id === messageId && row.seq === item.seq);
  if (!message || message.word !== "say" || message.kind !== "request" || !((message.from === "person:owner" && /^agent:/.test(message.to)) || (message.to === "person:owner" && /^agent:/.test(message.from)))) return null;
  const attachment = message.body?.attachments?.[index];
  if (!attachment || typeof attachment.name !== "string" || typeof attachment.mime_type !== "string") return null;
  if (typeof attachment.data === "string") return { name: attachment.name, mime_type: attachment.mime_type, data: attachment.data };
  if (typeof attachment.data?.$blob === "string") {
    const { data } = await net.readBlob(attachment.data.$blob);
    return { name: attachment.name, mime_type: attachment.mime_type, data: new TextDecoder().decode(data) };
  }
  return null;
}
