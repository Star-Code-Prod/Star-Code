# SSH sessions — design notes

A full remote session is not shipped yet. The minimal, safe design is:

1. `POST /api/sessions/new` accepts `ssh: { host, port, user, key, folder }`.
2. The server opens an SSH ControlMaster connection and creates a remote
   working folder/worktree.
3. The tool runner is pointed at the remote folder; file/preview/terminal
   endpoints run through `ssh <host> ...` instead of local `fs`.
4. Credentials stay in the OS keychain/SSH agent; never in session JSON.
5. If the connection drops, the turn stops with a clear error and the session
   stays resumable.

Out of scope for now: remote port forwarding UI, cloud-hosted sessions,
SSH jump-host management, and remote browser previews. Local sessions continue
to use the existing zero-dependency server.
