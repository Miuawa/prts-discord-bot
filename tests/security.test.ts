import { expect, test } from 'bun:test'
import { isPublicHost } from '../src/music.ts'

test('music links cannot reach the local machine or network', () => {
  for (const h of [
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '172.17.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '2130706433',
    '[::1]',
    'fd00::1',
    'fe80::1',
    'printer.local',
    'nas.lan',
  ])
    expect(isPublicHost(h)).toBe(false)
  for (const h of ['www.youtube.com', 'cdn.discordapp.com', '8.8.8.8', 'soundcloud.com']) expect(isPublicHost(h)).toBe(true)
})
