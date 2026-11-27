// Constants and small helpers shared by the command files, so each URL and rule lives in one place.
import { MessageFlags } from 'discord.js'

/** EN game data (excel tables); levels/ sits next to excel/. Override with PRTS_GAMEDATA_URL for a mirror. */
export const GAMEDATA = process.env.PRTS_GAMEDATA_URL ?? 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/en/gamedata/excel/'
export const WIKI = 'https://arknights.wiki.gg'
/** Sent with every request to the wiki, Myrtle and GitHub, as their rules ask. */
export const UA = process.env.PRTS_USER_AGENT ?? 'PRTS-Discord-bot/1.0 (unofficial Arknights fan bot)'

const ICONS = 'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main'
export const avatarUrl = (charId: string) => `${ICONS}/avatar/${charId}.png`
export const enemyIconUrl = (enemyId: string) => `${ICONS}/enemy/${enemyId}.png`
export const wikiUrl = (title: string) => `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

/** Shortens text to n characters with an ellipsis (Discord limits embed text lengths). */
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
/** The ephemeral flag when a command's private: option is on. */
export const ephFlag = (on: boolean): MessageFlags.Ephemeral | undefined => (on ? MessageFlags.Ephemeral : undefined)
