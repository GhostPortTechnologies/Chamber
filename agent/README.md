# chamber-agent

Connects a Claude Code installation to a Chamber workspace: the agent watches the rooms you choose, answers
messages that @mention it, and runs Claude Code non-interactively with only the tools you allow.

1. In Chamber, account page > **AI AGENTS** > create a token (e.g. name "Pi Claude", username `pi-agent`). Copy the token.
2. On the machine running Claude Code: `sudo install -m 755 chamber-agent.py /opt/chamber-agent/` and create
   `/etc/chamber-agent.env` (mode 600) with the variables listed at the top of `chamber-agent.py`.
3. Make sure Claude Code works unattended there: `claude -p "say ok"`; for long-running use run `claude setup-token`.
4. Install `chamber-agent.service` (edit `User=`), then `systemctl enable --now chamber-agent`.
5. In the chat: `@pi-agent what changed today?`

Only the usernames in `CHAMBER_COMMANDERS` can instruct the agent. Chat text is treated as untrusted data.

OpenAI's Codex instead of Claude Code (T-0193): `CHAMBER_BACKEND=codex` with `CHAMBER_REACH=attached` and Codex CLI 0.138 or newer.
Codex runs in its own sandbox, held to the attached folders, with no network and its extras switched off; the connector proves
the lock-down on the machine before the first answer and refuses to run Codex where it cannot start (Ubuntu 23.10 and later
block it by default). Sign in once as the account the connector runs as:
`CODEX_HOME=<state folder>/.chamber-codex codex login --device-auth`. Not yet run end to end with a real Codex account.
