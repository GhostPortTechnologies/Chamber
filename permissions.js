// permissions.js: who may do what in a Chamber workspace, in ONE table (T-0246).
//
// Before this file every feature carried its own "you may not" checks (about 80 of them), and nothing tested every role
// against every action. That is how a file could be moved by someone who could not delete it (T-0240). Now:
//   1. RULES below lists every action in Chamber and, for each role, whether it may do it.
//   2. The server reads this table: gate() refuses a request whose action says "no" for the caller's role before the
//      feature runs, and the features ask can() for the conditional answers ("only their own", "if the approval rules
//      allow", ...). The features' own refusals stay as a second line, and they read the same table.
//   3. test_permissions.js tries every role and an agent against every action and compares the answer with this table,
//      and checks that every route in server.js and accounts.js belongs to an action here. A new route without a row fails.
//   4. The "Who can do what" table in Help is made from RULES (tools/permissions-help.js), and a test keeps the two equal.
// Step 1 changes nobody's access: the table describes what the code allowed on 17 Nov 2026. Rows marked `review` are
// the mismatches found while mapping, listed for the owner to decide; nothing there was changed on our own judgment.
// T-0247 (approved by the owner 17 Nov 2026) made the five changes: the owner and admins remove any message, a room name that
// is taken is refused, a proposed ticket is changed only by its proposer, the owner or an admin, a ticket someone holds is reported
// on and closed only by them, the owner or an admin, and code reviews follow the owner's approval rules.
// T-0262 (approved 18 Nov 2026): giving back a ticket is for its holder, the owner or an admin; cancelling, for its proposer, the owner or an admin.
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
'use strict';

const ROLES = ['owner', 'admin', 'member', 'viewer', 'requester', 'agent'];
const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', requester: 'Requester', agent: 'Agent' };

// What a cell may say. Anything other than yes/no is decided by the feature with the facts in hand (who made the thing,
// the owner's approval rules, ...); the table says which fact.
const VALUES = {
  yes: 'Yes',
  no: 'No',
  own: 'Only their own',                            // what they shared, wrote, added, asked for, proposed or hold
  approver: 'If the approval rules allow',          // Account, Approval rules: by default the owner, admins and members; a viewer only when named
  commander: 'If they may instruct agents',        // Account, AI agents, "who may give agents instructions" (default: the owner only)
  setting: 'If the owner switches it on',           // a switch in Settings, off until the owner turns it on
  operator: 'Only the people who run this server',  // the site operators of this Chamber copy, never a customer's workspace role
};

// One row per action. `routes` are "METHOD /path" with :name for one path part. A route may belong to one row only.
// `also` names the rows a feature checks inside the same route (for example POST /api/folders creates, renames or deletes).
// `recorded`: an agent's attempt is refused by the feature itself (which reads this table too), because the feature writes the
// refused attempt on the activity record (an agent trying to approve is worth knowing). The gate lets agents through to it.
// `note` is shown in Help. `deny` replaces the refusal sentence for people (guests and agents keep theirs). `review` marks a finding for the owner to decide (see the T-0246 ticket); it is not shown in Help.
const RULES = [
  // ── Using the app ────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'app.open', area: 'Using the app', what: 'Open the app: who is here, live updates, staying online',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/me', 'GET /api/events', 'GET /api/events/wait', 'POST /api/ping', 'GET /api/presence', 'GET /api/users', 'GET /api/theme'] },
  { id: 'app.prefs', area: 'Using the app', what: 'Save their own preferences that agents read',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'no',
    routes: ['POST /api/me/prefs'] },

  // ── Chat ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'chat.read', area: 'Chat', what: 'Read the rooms, threads, pins and search, and open chat archives',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    note: 'Direct messages are seen only by the two people in them, whatever their role.',
    routes: ['GET /api/messages', 'GET /api/messages/thread', 'GET /api/messages/replies', 'GET /api/messages/pins', 'GET /api/messages/one', 'GET /api/search', 'GET /api/rooms', 'GET /api/archives', 'GET /api/archives/:id'] },
  { id: 'chat.post', area: 'Chat', what: 'Post messages, react and pin',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/messages', 'POST /api/messages/react', 'POST /api/messages/pin'] },
  { id: 'chat.edit', area: 'Chat', what: 'Edit a message',
    owner: 'own', admin: 'own', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Nobody changes the words of someone else\'s message.',
    routes: ['POST /api/messages/edit'] },
  { id: 'chat.delete', area: 'Chat', what: 'Delete a message',                                                   // T-0247
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'The owner and admins can remove anyone\'s message in the rooms they can see (never a direct message between two other people). The activity record says who removed whose message.',
    routes: ['POST /api/messages/delete'] },
  { id: 'chat.rooms', area: 'Chat', what: 'Make a room or open a direct message',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    note: 'A room name that is already taken is refused; the existing room stays as it was.',                       // T-0247
    routes: ['POST /api/rooms'] },
  { id: 'chat.stop', area: 'Chat', what: 'Stop an agent working on a message',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'no',
    note: 'A member can stop work they asked for.',
    routes: ['POST /api/messages/stop'] },
  { id: 'chat.archive', area: 'Chat', what: 'Archive old chat (sealed and removed from the room)',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/archives'] },

  // ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'files.read', area: 'Files', what: 'See and download files and folders',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    note: 'Only files shared in rooms they can see.',
    routes: ['GET /api/files', 'GET /api/files/:id', 'GET /api/files/:id/versions', 'GET /api/files/:id/versions/:vid', 'GET /api/folders'] },
  { id: 'files.upload', area: 'Files', what: 'Share a file',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/files'] },
  { id: 'files.manage', area: 'Files', what: 'Move or delete a file, or upload a new version of it',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Members and agents: files they shared themselves. An agent also: the files of a person who approved a [files] ticket the agent is working on right now (T-0273).',
    routes: ['DELETE /api/files/:id', 'PATCH /api/files/:id', 'POST /api/files/:id/version'] },
  { id: 'folders.create', area: 'Files', what: 'Make a folder',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    also: ['folders.change'],
    routes: ['POST /api/folders'] },
  { id: 'folders.change', area: 'Files', what: 'Rename or delete a folder',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'no',
    note: 'Members: a folder that is empty or holds only files they shared. Renaming or deleting moves every file inside (T-0244).',
    routes: [] },

  // ── Requests (the plain-words way in for people outside the team) ────────────────────────────────────────────────
  { id: 'requests.follow', area: 'Requests', what: 'Follow their own requests and open their files',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'yes', agent: 'no',
    routes: ['GET /api/requests', 'GET /api/requests/files/:id'] },
  { id: 'requests.send', area: 'Requests', what: 'Send a request, answer a question about it, choose its emails',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'yes', agent: 'no',
    routes: ['POST /api/requests', 'POST /api/requests/files', 'POST /api/requests/answer', 'POST /api/requests/mail'] },

  // ── Tickets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'tickets.read', area: 'Tickets', what: 'See tickets, their changes and comments, standing approvals and code reviews',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/tickets', 'GET /api/tickets/export', 'GET /api/tickets/:id/diff', 'GET /api/tickets/:id/comments', 'GET /api/standing', 'GET /api/reviews', 'GET /api/reviews/:id'] },
  { id: 'tickets.propose', area: 'Tickets', what: 'Propose a ticket',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/tickets', 'POST /api/proposals'] },
  { id: 'tickets.comment', area: 'Tickets', what: 'Comment on a ticket or a line of its change',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/tickets/:id/comments'] },
  { id: 'tickets.edit', area: 'Tickets', what: 'Change a ticket that is still proposed',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',                         // T-0247
    note: 'Members and agents: only tickets they proposed. Nobody changes a ticket once it is approved.',
    routes: ['POST /api/tickets/:id/edit'] },
  { id: 'tickets.decide', area: 'Tickets', what: 'Approve or reject a ticket', recorded: true,
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',
    note: 'The owner\'s approval rules decide: by default the owner, admins and members; a viewer only when named. Nobody approves their own proposal if the owner says so, and two people can be required.',
    routes: ['POST /api/tickets/:id/approve', 'POST /api/tickets/:id/reject'] },
  { id: 'tickets.changes', area: 'Tickets', what: 'Ask for changes to a proposed change',
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',
    note: 'The same people who may reject it.',
    also: ['tickets.unchanges'],
    routes: ['POST /api/tickets/:id/changes'] },
  { id: 'tickets.unchanges', area: 'Tickets', what: 'Withdraw a request for changes',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'own', requester: 'no', agent: 'no',
    note: 'Whoever asked for the changes, the owner or an admin.',
    routes: [] },
  { id: 'tickets.reviewer', area: 'Tickets', what: 'Name a reviewer for a proposed change',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/reviewer'] },
  { id: 'tickets.check', area: 'Tickets', what: 'Check finished work (Looks good, Send back)', recorded: true,
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/check'] },   // T-0309: no bulk check
  { id: 'tickets.standing', area: 'Tickets', what: 'Set up, confirm or withdraw a standing approval',
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',
    routes: ['POST /api/standing', 'POST /api/standing/:id/withdraw', 'POST /api/standing/:id/confirm'] },
  { id: 'tickets.claim', area: 'Tickets', what: 'Take an approved ticket',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    note: 'Agents never take a ticket meant for a person.',
    routes: ['POST /api/tickets/:id/claim'] },
  { id: 'tickets.work', area: 'Tickets', what: 'Report progress on a ticket and close it',                       // T-0247
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Members and agents: only a ticket they hold (they took it). While nobody holds a ticket, the person or agent who proposed it may add notes; closing needs its holder, the owner or an admin.',
    routes: ['POST /api/tickets/:id/update', 'POST /api/tickets/:id/close', 'POST /api/tickets/:id/log'] },
  { id: 'tickets.release', area: 'Tickets', what: 'Give back a ticket someone is working on (it goes back to approved)',   // T-0262
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Members and agents: only a ticket they hold. The owner and admins can give back any, for example when an agent is stuck.',
    routes: ['POST /api/tickets/:id/release'] },
  { id: 'tickets.cancel', area: 'Tickets', what: 'Cancel a ticket',                                                     // T-0262
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Members and agents: only tickets they proposed.',
    routes: ['POST /api/tickets/:id/cancel'] },
  { id: 'tickets.for', area: 'Tickets', what: 'Decide whether a person or an agent does a ticket',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/for'] },
  { id: 'tickets.diff', area: 'Tickets', what: 'Attach a change (code) to a ticket',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Members and agents: tickets they proposed.',
    routes: ['POST /api/tickets/:id/diff'] },
  { id: 'tickets.applied', area: 'Tickets', what: 'Record where an approved change was put in place',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/tickets/:id/applied'] },
  { id: 'tickets.revert', area: 'Tickets', what: 'Ask to undo a change that was put in place',
    owner: 'yes', admin: 'yes', member: 'commander', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/revert'] },
  { id: 'tickets.pr', area: 'Tickets', what: 'Record a ticket\'s pull request',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'own',
    note: 'An agent: only on the ticket it is working on.',
    routes: ['POST /api/tickets/:id/pr'] },
  { id: 'tickets.draft', area: 'Tickets', what: 'Write a draft plan for a request',
    owner: 'no', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['GET /api/drafts/next', 'POST /api/tickets/:id/draft'] },
  { id: 'tickets.usedraft', area: 'Tickets', what: 'Put an agent\'s draft plan into the ticket',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/draft/use'] },
  { id: 'tickets.question', area: 'Tickets', what: 'Ask the person who sent a request a question',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tickets/:id/question'] },
  { id: 'tickets.standingcheck', area: 'Tickets', what: 'Ask whether a standing approval covers a ticket',
    owner: 'own', admin: 'own', member: 'own', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Only whoever is working on that ticket.',
    routes: ['POST /api/tickets/:id/standing-check'] },
  { id: 'tickets.evidence', area: 'Tickets', what: 'Open an evidence pack',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'no',
    routes: ['GET /api/tickets/:id/evidence', 'GET /api/evidence'] },
  { id: 'reviews.create', area: 'Tickets', what: 'Start a code review',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'yes',
    routes: ['POST /api/reviews'] },
  { id: 'reviews.decide', area: 'Tickets', what: 'Approve or reject a code review',
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',      // T-0247
    note: 'The owner\'s approval rules decide, as for tickets: who may approve, and whether someone may approve a review they started. One approval decides a review.',
    routes: ['POST /api/reviews/:id/approve', 'POST /api/reviews/:id/reject'] },

  // ── Tasks ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'tasks.read', area: 'Tasks', what: 'See the Tasks checklist',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'setting',
    note: 'Agents: when the owner switches on "Agents can see the Tasks list" (Settings; off at first).',
    routes: ['GET /api/tasks'] },
  { id: 'tasks.add', area: 'Tasks', what: 'Add a task',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tasks'] },
  { id: 'tasks.propose', area: 'Tasks', what: 'Propose a task',                                                      // T-0264
    deny: 'People add tasks with + Task; proposing is for agents.',
    owner: 'no', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'setting',
    note: 'Agents, when the owner lets them see the Tasks list. A proposed task waits for the owner or an admin: until then it is not due, cannot be ticked and sends no reminder.',
    routes: ['POST /api/tasks/propose'] },
  { id: 'tasks.confirm', area: 'Tasks', what: 'Confirm a task an agent proposed',                                    // T-0264
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tasks/:id/confirm'] },
  { id: 'tasks.tick', area: 'Tasks', what: 'Tick a task off',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'setting',
    note: 'Agents: only tasks a person marked "an agent may tick this off", and the agent must say what it checked; the tick shows its name and that note.',
    routes: ['POST /api/tasks/:id/done'] },
  { id: 'tasks.untick', area: 'Tasks', what: 'Take a tick back',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/tasks/:id/undo'] },
  { id: 'tasks.manage', area: 'Tasks', what: 'Change or remove a task',
    owner: 'yes', admin: 'yes', member: 'own', viewer: 'no', requester: 'no', agent: 'no',
    note: 'Members: tasks they added.',
    routes: ['POST /api/tasks/:id', 'POST /api/tasks/:id/remove'] },

  // ── Agents ───────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'memory.read', area: 'Agents', what: 'Read an agent\'s notes (memory)',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/memory'] },
  { id: 'memory.edit', area: 'Agents', what: 'Add or remove an agent\'s notes',
    owner: 'yes', admin: 'yes', member: 'commander', viewer: 'no', requester: 'no', agent: 'own',
    note: 'An agent: only its own notes.',
    routes: ['POST /api/memory', 'POST /api/memory/delete'] },
  { id: 'asks.read', area: 'Agents', what: 'See agents\' questions asked mid-job',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'own',
    routes: ['GET /api/asks', 'GET /api/asks/:id'] },
  { id: 'asks.ask', area: 'Agents', what: 'Ask a person to allow a step mid-job',
    owner: 'no', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'setting',
    note: 'Account, AI agents, "may ask", for each agent.',
    routes: ['POST /api/asks'] },
  { id: 'asks.follow', area: 'Agents', what: 'Follow up a question it asked (cancel it, report the result)',
    owner: 'no', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'own',
    routes: ['POST /api/asks/:id/result', 'POST /api/asks/:id/cancel', 'POST /api/asks/:id/use', 'POST /api/asks/:id/end'] },
  { id: 'asks.answer', area: 'Agents', what: 'Answer an agent\'s question (Allow or Deny)', recorded: true,
    owner: 'approver', admin: 'approver', member: 'approver', viewer: 'approver', requester: 'no', agent: 'no',
    routes: ['POST /api/asks/:id/answer'] },
  { id: 'agents.usage', area: 'Agents', what: 'See what the agents\' work cost and how long it took',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'no',
    routes: ['GET /api/usage'] },
  { id: 'agents.phoneai', area: 'Agents', what: 'See the phone AI settings',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/ask-config'] },
  { id: 'agents.phoneaiset', area: 'Agents', what: 'Change the phone AI settings',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/ask-config'] },
  { id: 'agents.tokens', area: 'Agents', what: 'Add or remove agents (tokens, pairing a device)',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['GET /account/workspace/tokens', 'POST /account/workspace/tokens', 'POST /account/workspace/tokens/revoke', 'POST /account/workspace/pair'] },
  { id: 'agents.askswitch', area: 'Agents', what: 'Let an agent ask mid-job ("may ask")',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/tokens/ask'] },
  { id: 'agents.peerswitch', area: 'Agents', what: 'Let an agent answer other agents ("answers other agents")',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    note: 'It only answers: it reads, and never runs or changes anything because another agent asked.',
    routes: ['POST /account/workspace/tokens/peers'] },
  { id: 'agents.automation', area: 'Agents', what: 'Schedules, webhooks and room forwarding',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['GET /account/workspace/automation', 'POST /account/workspace/schedules', 'POST /account/workspace/schedules/:id', 'POST /account/workspace/mirrors', 'POST /account/workspace/mirrors/:id', 'POST /account/workspace/hooks', 'POST /account/workspace/hooks/:id'] },

  // ── Terminal and machines ────────────────────────────────────────────────────────────────────────────────────────
  { id: 'terminal.use', area: 'Terminal and machines', what: 'Run commands on their own machines (Terminal)',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/shell', 'POST /api/shell/:id/cancel', 'GET /api/shell/:id'] },
  { id: 'terminal.server', area: 'Terminal and machines', what: 'Run commands on the Chamber server itself',
    owner: 'operator', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /api/console'] },
  { id: 'terminal.connector', area: 'Terminal and machines', what: 'Collect and answer Terminal commands (the connector on the machine)',
    owner: 'no', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'own',
    note: 'Only commands sent to that agent.',
    routes: ['GET /api/shell/pending', 'POST /api/shell/result'] },
  { id: 'fleet.read', area: 'Terminal and machines', what: 'See the workspace\'s GhostPort routers',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/fleet/routers'] },
  { id: 'fleet.link', area: 'Terminal and machines', what: 'Link GhostPort routers to the workspace',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/fleet'] },
  { id: 'github.link', area: 'Terminal and machines', what: 'Link or unlink a GitHub repository',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['GET /api/github-link', 'POST /api/github-link', 'POST /api/github-link/remove'] },

  // ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'activity.read', area: 'Records', what: 'Open the Activity tab and export it',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'yes',
    routes: ['GET /api/activity', 'GET /api/activity/progress'] },
  { id: 'audit.read', area: 'Records', what: 'Read the who-did-what record and check it is intact',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'no',
    also: ['audit.export'],
    routes: ['GET /account/workspace/audit', 'GET /account/workspace/audit/verify'] },
  { id: 'audit.export', area: 'Records', what: 'Export the whole who-did-what record',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: [] },

  // ── Workspace (Settings, Team) ───────────────────────────────────────────────────────────────────────────────────────
  { id: 'ws.view', area: 'Workspace', what: 'See the workspace: members, roles, plan, owner lock',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'no', agent: 'no',
    note: 'Email addresses and invite links: the owner and admins only.',
    routes: ['GET /account/workspace', 'GET /account/workspace/lock'] },
  { id: 'ws.rename', area: 'Workspace', what: 'Rename the workspace',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    also: ['ws.settings'],
    routes: ['POST /account/workspace'] },
  { id: 'ws.settings', area: 'Workspace', what: 'Approval rules, who instructs agents, AI budget, how long records are kept, request drafts, security rules for everyone',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: [] },
  { id: 'ws.members', area: 'Workspace', what: 'Remove a member',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    note: 'An admin cannot remove the owner or another admin.',
    routes: ['POST /account/workspace/remove'] },
  { id: 'ws.invites', area: 'Workspace', what: 'Make, renew or switch off invite links',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/invite-reset'] },
  { id: 'ws.roles', area: 'Workspace', what: 'Change someone\'s role',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/role'] },
  { id: 'ws.transfer', area: 'Workspace', what: 'Hand the workspace to someone else',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    note: 'Needs the owner\'s password.',
    routes: ['POST /account/workspace/transfer'] },
  { id: 'ws.report', area: 'Workspace', what: 'Set up the weekly report',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/report'] },
  { id: 'ws.lock', area: 'Workspace', what: 'Switch the owner lock on or off, open or close it',
    deny: 'Only the workspace owner can lock or unlock it: the key is theirs.',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['POST /account/workspace/lock', 'POST /account/workspace/lock/unlock', 'POST /account/workspace/lock/close'] },
  { id: 'ws.records', area: 'Workspace', what: 'Keep sealed copies of the record and open them',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['GET /account/workspace/ownerkey', 'POST /account/workspace/ownerkey', 'GET /account/workspace/records-saved', 'POST /account/workspace/records-saved', 'GET /account/workspace/records-saved/:id', 'POST /account/workspace/records-saved/:id/delete'] },
  { id: 'ws.export', area: 'Workspace', what: 'Export or import the whole workspace',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    routes: ['GET /account/export', 'POST /account/import'] },
  { id: 'ws.billing', area: 'Workspace', what: 'Subscribe; change the plan, monthly or yearly, or the extra storage; change the card or see the invoices; cancel the plan',
    owner: 'yes', admin: 'no', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    note: 'It is the owner\'s card, so only the owner changes what it pays for.',
    routes: ['POST /billing/checkout', 'POST /billing/portal', 'POST /billing/cancel', 'POST /billing/preview', 'POST /billing/plan', 'POST /billing/storage'] },   // T-0295; T-0311: the owner only (their answer, 20 Nov)
  { id: 'ws.billing.view', area: 'Workspace', what: 'The Billing tab: see the plan, the next charge and the storage used',
    owner: 'yes', admin: 'yes', member: 'no', viewer: 'no', requester: 'no', agent: 'no',
    note: 'Admins can look but change nothing. Approvers, viewers and requesters see no prices.',
    routes: ['GET /billing/overview'] },   // T-0311

  // ── Their own account ────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'account.own', area: 'Their own account', what: 'Password, email, two-step sign-in, notifications, screen lock, signed-in devices, delete their account',
    owner: 'yes', admin: 'yes', member: 'yes', viewer: 'yes', requester: 'yes', agent: 'no',
    note: 'Everyone manages only their own account, within the workspace\'s security rules (stricter is always allowed). Agents have no Settings page.',
    routes: ['GET /account/passkeys', 'POST /account/passkey-login', 'POST /account/passkeys/options', 'POST /account/passkeys/add', 'POST /account/passkeys/remove', 'POST /account/passkeys/use',
             'GET /account/recheck-settings', 'POST /account/recheck-settings', 'POST /account/recheck', 'GET /account/me', 'POST /account/password', 'POST /account/email', 'POST /account/delete', 'POST /account/logout', 'POST /account/logout-all', 'POST /account/verify-resend',
             'GET /account/totp', 'POST /account/totp/setup', 'POST /account/totp/confirm', 'POST /account/totp/disable', 'GET /account/notify', 'POST /account/notify', 'POST /account/quiet',
             'GET /account/push', 'POST /account/push', 'POST /account/push/clear', 'GET /account/screen-lock', 'POST /account/screen-lock', 'POST /account/unlock', 'POST /account/activity', 'POST /account/lock',
             'GET /account/sessions', 'POST /account/sessions/revoke', 'POST /account/session-policy'] },
];

const BY_ID = new Map(RULES.map(r => [r.id, r]));

// T-0241 part 4: the actions that ask for the password again (when the person or the owner's rules chose it and the last
// check is too old): deciding tickets and agents' questions, the Terminal, deleting files, security and workspace settings,
// agents and tokens, export, import and deleting the account. Shown in Help.
const RECHECK = ['POST /api/tickets/:id/approve', 'POST /api/tickets/:id/reject', 'POST /api/asks/:id/answer', 'POST /api/shell', 'POST /api/console', 'DELETE /api/files/:id',
  'POST /account/screen-lock', 'POST /account/session-policy', 'POST /account/recheck-settings', 'POST /account/passkeys/add', 'POST /account/passkeys/remove', 'POST /account/passkey-login', 'POST /account/totp/setup', 'POST /account/totp/disable', 'POST /account/email', 'POST /account/delete',
  'GET /account/export', 'POST /account/import', 'POST /account/workspace', 'POST /account/workspace/role', 'POST /account/workspace/remove', 'POST /account/workspace/transfer',
  'POST /account/workspace/tokens', 'POST /account/workspace/tokens/revoke', 'POST /account/workspace/tokens/ask', 'POST /account/workspace/tokens/peers', 'POST /account/workspace/pair', 'POST /account/workspace/invite-reset',
  'POST /account/workspace/schedules', 'POST /account/workspace/schedules/:id', 'POST /account/workspace/mirrors', 'POST /account/workspace/mirrors/:id', 'POST /account/workspace/hooks', 'POST /account/workspace/hooks/:id',
  'POST /account/workspace/lock', 'POST /account/workspace/lock/close', 'POST /account/workspace/fleet', 'POST /api/github-link', 'POST /api/github-link/remove'];
const RECHECK_RE = RECHECK.map(rt => { const [m, p] = rt.split(' '); return { m, re: new RegExp('^' + p.split('/').map(x => x.startsWith(':') ? '[^/]+' : x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('/') + '$') }; });
function recheckRoute(method, pathname) { return RECHECK_RE.some(x => x.m === method && x.re.test(pathname)); }

// ── Routes → rows ────────────────────────────────────────────────────────────────────────────────────────────────────
// A literal part outranks a :name part, so "GET /api/shell/pending" wins over "GET /api/shell/:id".
const ROUTES = [];
for (const r of RULES) for (const rt of r.routes) {
  const [method, p] = rt.split(' ');
  const parts = p.split('/').slice(1);
  ROUTES.push({ method, path: p, rule: r, parts, re: new RegExp('^/' + parts.map(x => x.startsWith(':') ? '[^/]+' : x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('/') + '$'), literal: parts.filter(x => !x.startsWith(':')).length });
}
ROUTES.sort((a, b) => b.literal - a.literal || b.parts.length - a.parts.length);

function ruleFor(method, pathname) {                                         // the row a request belongs to, or null
  const m = method === 'HEAD' ? 'GET' : method;
  for (const x of ROUTES) if (x.method === m && x.re.test(pathname)) return x.rule;
  return null;
}

// ── Who is asking ────────────────────────────────────────────────────────────────────────────────────────────────────
// accounts: the accounts module (accounts.sessionRole). Without accounts (the classic single board) every person acts as
// the owner, as before; the one old exception is kept by tasks (see server.js taskCanManage).
function roleOf(sess, accounts) {
  if (!sess || !sess.username) return null;
  if (sess.agent || sess.role === 'ai') return 'agent';
  if (!accounts || !accounts.enabled) return 'owner';
  const r = accounts.sessionRole(sess);
  return ROLES.includes(r) ? r : null;
}

function cell(role, id) {
  const r = BY_ID.get(id); if (!r) throw new Error(`permissions: no rule "${id}"`);
  return role && Object.hasOwn(r, role) ? r[role] : 'no';
}

// can(role, id, facts): the answer for one action. facts: { own, approver, commander, setting, operator } as booleans,
// given by the feature that knows them. A conditional cell without its fact is a refusal (fail closed).
function allows(role, id, facts = {}) {
  const v = cell(role, id);
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return facts[v] === true;
}
function can(sess, accounts, id, facts) { return allows(roleOf(sess, accounts), id, facts); }

// The refusal a role gets for a row whose cell says "no". The guest roles keep the sentences they had (T-0199).
function whoMay(r) {
  const ok = ROLES.filter(x => x !== 'agent' && r[x] !== 'no');
  if (ok.length === 1 && ok[0] === 'owner') return 'the workspace owner';
  if (ok.length === 2 && ok.includes('owner') && ok.includes('admin')) return 'the workspace owner or an admin';
  return null;
}
function refusal(role, r) {
  if (role === 'requester') return 'You are a requester in this workspace: you can send requests and follow your own, nothing else.';
  if (role === 'viewer') return 'You are a viewer in this workspace: you can read, not change anything.';
  if (role === 'agent') return `${r.what}: this is for people, not agents.`;
  if (r.deny) return r.deny;
  const w = whoMay(r);
  return w ? `Only ${w} can do that.` : `${r.what}: your role in this workspace cannot do this.`;
}

// gate(role, method, path): before a feature runs. Returns null to go on, or { status: 403, error, rule } to refuse.
// Only a plain "no" is refused here; conditional cells are left to the feature, which knows the facts.
// A path that is no action at all: guests are refused as before T-0246 (a requester everywhere, a viewer on any change);
// everyone else gets the usual "not found" from the server.
function gate(role, method, pathname) {
  if (!role) return null;
  const r = ruleFor(method, pathname);
  if (!r) return role === 'requester' || (role === 'viewer' && method !== 'GET' && method !== 'HEAD') ? { status: 403, error: refusal(role, { what: '' }), rule: null } : null;
  if (cell(role, r.id) !== 'no') return null;
  if (r.recorded && role === 'agent') return null;
  return { status: 403, error: refusal(role, r), rule: r.id };
}

module.exports = { ROLES, ROLE_NAMES, VALUES, RULES, RECHECK, recheckRoute, ruleFor, roleOf, cell, allows, can, gate, refusal };
