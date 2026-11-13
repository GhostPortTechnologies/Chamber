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
