// Calling SpiriSynq methods (docs/protocol.md §7 in SpiriSynq) over a
// zenoh.js connection.

const CALL_TIMEOUT_MS = 30000;

// Arguments travel as selector parameters: `;`-separated, each a YAML
// document. Zenoh doesn't escape anything, so `%` and `;` are percent-encoded
// and the server decodes them.
export function selector(path, method, args) {
  const params = Object.entries(args).map(([k, yaml]) => `${k}=${yaml.replace(/%/g, "%25").replace(/;/g, "%3B")}`);
  return `${path}/${method}${params.length ? `?${params.join(";")}` : ""}`;
}

// Calls a method with arguments already written as YAML ({ value: "2.5" }).
// onReply({ yaml, done, error }) sees each reply as it comes: a generator
// sends one per value, then a `done` reply with its return value. An error
// reply's text is SpiriSynq's `RPC error '…'`.
export async function callMethod(zenoh, path, method, args, onReply) {
  const replies = await zenoh.query(selector(path, method, args), {
    timeoutMs: CALL_TIMEOUT_MS,
    onReply: (r) =>
      onReply(
        r instanceof Error
          ? { error: r.message }
          : { yaml: r.payload().toString(), done: r.encoding().toString().includes("generator-done") },
      ),
  });
  if (!replies.length) onReply({ error: "nothing answered" });
}
