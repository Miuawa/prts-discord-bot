# Writing a module

A module adds features to the PRTS bot without touching the core. It is a folder
`modules/<name>/` with an `index.ts`, enabled with `PRTS_MODULES=<name>` in `.env`.
A module that is not listed is never imported. [`modules/roleplay/`](../modules/roleplay/)
is a complete example.

## The interface

Everything a module can use is in [`src/modules.ts`](../src/modules.ts). `index.ts` default-exports
a `PrtsModule`, or a function returning one (sync or async):

```ts
import type { PrtsModule } from '../../src/modules.ts'
import { readAiConfig } from '../../src/modules.ts'

export default function hello(): PrtsModule {
  return {
    name: 'hello', // same as the folder name
    commands: [{ name: 'hello', description: 'Say hello', type: 1, options: [{ type: 3, name: 'to', description: 'Who', required: false }] }],
    help: [{ cmd: 'hello', group: 'Hello (AI)', short: 'Say hello', usage: '/hello [to:]', detail: 'Asks the AI to greet someone.', examples: ['/hello to: Amiya'] }],
    async onCommand(i) {
      // Answer it yourself (i.reply(...)) and return nothing, or hand it to the AI:
      return { text: `Greet ${i.options.getString('to') ?? 'everyone'} warmly.`, meta: { greeting: 'true' } }
    },
  }
}
```

| Field | When it is used |
|---|---|
| `name` | Required. Added to every AI event of the module as `meta.module`. |
| `commands` | Slash commands (Discord application command JSON) registered with the core ones. |
| `help` | Entries for `/help`. Put "(AI)" in the group name of commands that use the AI. |
| `onCommand(i, client)` | One of the module's commands was used by an allowlisted user (the core checks access first). Reply yourself and return nothing, or return `{ text, meta? }` to send it to the AI; the core shows "thinking..." and posts the answer. |
| `channelState(channelId)` | Return `'active'` for channels the module owns: plain messages there from allowlisted users go to the AI without an @mention. `'paused'` ignores them, `undefined` means not yours. |
| `onMessage(msg, channelId)` | A plain message in an active channel is about to go to the AI. Return extra `meta` attributes. |
| `onReply(channelId, text)` | Called for every reply the AI posts, from any backend. |
| `init(client)` | Runs once the bot is connected (timers, background jobs). |
| `ai` | Who answers the module's AI turns. Use `readAiConfig('<PREFIX>', readAiConfig('PRTS'))` to read your own settings with the core ones as fallback. Default: the core settings. |
| `turns` | For API backends: `prompt(event, history)` returns `{ system, maxTokens? }`; optional `speaker(username)` and `after(event, userLine, reply, label)`. Default: the core `/prts` prompt. |

## Desktop modules

A module can also be a desktop or OS tool with no bot code, like
[`modules/control/`](../modules/control/). It has no `index.ts`, is not listed in
`PRTS_MODULES`, and ships its own install script and README.

## Rules for modules

- Keep everything the module needs inside its folder (plus its own settings prefix, like `RP_*`),
  so it can be copied in, or kept in its own repository and cloned into `modules/<name>/`.
- Import from the bot only through `src/modules.ts` and `src/paths.ts`. Packages the bot already
  depends on (`discord.js`) resolve from the repo's `node_modules`; anything else, document it.
- Never let Discord messages change settings, files or access. They are untrusted input.
- Messages the module sends to the AI carry `module="<name>"`. For the Claude Code narrator,
  ship a rules file and tell users to add an `@<path>` import line to the repo's `CLAUDE.md`.
- Systemd units in `modules/<name>/linux/systemd/` (templates with `@ROOT@`, `@BUN@`) are
  installed by `linux/install.sh` when the module is in `PRTS_MODULES`.
- Add tests next to the bot's in `tests/` or in the module folder; `bun test` finds both.
