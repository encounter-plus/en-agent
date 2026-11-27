// OpenCode 2.4 stores message parts separately. Older fixture databases embed them in data.
export function lastAssistantMessage(db,sessionId){
  const row=db.prepare("SELECT id,data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1").get(sessionId);
  if(!row)return null;
  const message=JSON.parse(row.data);
  if(!message.content?.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_part'").get()){
    message.content=db.prepare('SELECT data FROM session_part WHERE message_id=? ORDER BY ordinal').all(row.id).map(part=>JSON.parse(part.data));
  }
  return message;
}
