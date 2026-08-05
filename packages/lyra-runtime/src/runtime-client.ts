const endpoint = process.env.LYRA_RUNTIME_URL;
const token = process.env.LYRA_RUNTIME_TOKEN;
if (!endpoint || !token) throw new Error("lyra:runtime is only available inside a Lyra JIT subprocess.");
const runtimeEndpoint: string = endpoint;
const runtimeToken: string = token;

async function call(method: string, args: unknown): Promise<unknown> {
  const response = await fetch(runtimeEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${runtimeToken}` },
    body: JSON.stringify({ method, args }),
  });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error(`Runtime bridge returned invalid JSON for ${method}.`);
  if (!response.ok || (payload as { ok?: unknown }).ok !== true) throw new Error(String((payload as { error?: unknown }).error ?? `Runtime call ${method} failed.`));
  return (payload as { result?: unknown }).result;
}

export const lyra = Object.freeze({
  spawn: (options: unknown) => call("spawn", options),
  exec: (command: string, options?: unknown) => call("exec", { command, options }),
  read: (args: unknown) => call("tool.read", args),
  write: (args: unknown) => call("tool.write", args),
  edit: (args: unknown) => call("tool.edit", args),
  glob: (args: unknown) => call("tool.glob", args),
  grep: (args: unknown) => call("tool.grep", args),
  irc: Object.freeze({
    send: (args: unknown) => call("irc.send", args),
    publish: (args: unknown) => call("irc.publish", args),
    wait: (args: unknown) => call("irc.wait", args),
  }),
  git: Object.freeze({
    preview: (args?: unknown) => call("git.preview", args),
    apply: (args?: unknown) => call("git.apply", args),
    rollback: (args?: unknown) => call("git.rollback", args),
  }),
  workspace: Object.freeze({
    create: (args?: unknown) => call("workspace.create", args),
    list: (args?: unknown) => call("workspace.list", args),
    drop: (args?: unknown) => call("workspace.drop", args),
  }),
  report: (message: string) => call("report", { message }),
  checkpoint: (state: unknown) => call("checkpoint", { state }),
});
