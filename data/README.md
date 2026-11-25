# data/

Local data the bot downloads or you add. Git ignores the contents.

- `sheets/*.txt`: copies of the community spreadsheets (AK Tier List, DragonGJY module
  ratings, PeterYR farming, RIIC base guide) used by `/tier`, `/module`, `/farm` and `/base`.
  The bot creates and refreshes them from Google every 6 hours. They belong to their authors.
- `stories.json` (optional): a story index for `/story`. Without it, `/story` still links to
  the story reader. Not included, because it would contain game text.

Change the folder with `PRTS_DATA_DIR`.
