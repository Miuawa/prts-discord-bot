# Story logs

One Markdown file per story. The Claude Code narrator appends each turn itself. With an
API backend, the module gives the model the end of the most recently changed file (or the
one named in `RP_STORY_LOG`) and appends the model's in-character turns there.
