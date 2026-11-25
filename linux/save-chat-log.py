"""Saves the narrator's current conversation before a manual restart.
  logs/chat-logs/chat-<time>.md  full readable log (Discord messages, PRTS replies, terminal chat)
  logs/restart-handoff.md        the last part of it, for the NEW session to read at start
Linux version of windows/save-chat-log.ps1. Reads the newest Claude Code
transcript of this project folder."""
import json, os, re, sys
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parent.parent
# Claude Code names a project's folder after its path, with / and . replaced by -.
proj = Path.home() / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(root))
files = sorted(proj.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
if not files:
    print(f'No transcript found in {proj}.')
    sys.exit(1)
src = files[0]

def clip(s, n=1500):
    return s if len(s) <= n else s[:n] + ' [...]'

entries = []
for line in src.open(encoding='utf-8'):
    try:
        o = json.loads(line)
    except ValueError:
        continue
    if o.get('type') not in ('user', 'assistant'):
        continue
    c = (o.get('message') or {}).get('content')
    ts = ''
    if o.get('timestamp'):
        try:
            ts = datetime.fromisoformat(o['timestamp'].replace('Z', '+00:00')).astimezone().strftime('%m-%d %H:%M')
        except ValueError:
            pass
    if isinstance(c, str):
        if o['type'] == 'user':
            entries.append(f'[{ts}] IN: ' + clip(c))
        continue
    for b in c or []:
        t = b.get('type')
        if o['type'] == 'user' and t == 'text':
            entries.append(f'[{ts}] IN: ' + clip(b.get('text', '')))
        elif o['type'] == 'assistant' and t == 'text' and b.get('text', '').strip():
            entries.append(f'[{ts}] PRTS (terminal): ' + clip(b['text']))
        elif o['type'] == 'assistant' and t == 'tool_use' and b.get('name') == 'mcp__discord__reply':
            entries.append(f'[{ts}] PRTS -> Discord: ' + clip(str((b.get('input') or {}).get('text', ''))))

stamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
logdir = root / 'logs' / 'chat-logs'
logdir.mkdir(parents=True, exist_ok=True)
log = logdir / f'chat-{stamp}.md'
log.write_text(f'# Narrator chat log, saved {stamp}\nSource transcript: {src.name}\n\n' + '\n\n'.join(entries), encoding='utf-8')

keep, size = [], 0
for e in reversed(entries):
    size += len(e) + 2
    if size > 12000:
        break
    keep.insert(0, e)
(root / 'logs' / 'restart-handoff.md').write_text(
    f"# Restart handoff\nsaved: {stamp}\nfull log: {log}\n\nThis is the end of the previous session's chat "
    "(older parts are in the full log). Continue from here.\n\n" + '\n\n'.join(keep), encoding='utf-8')
print(f'Saved {log} ({len(entries)} entries)')
