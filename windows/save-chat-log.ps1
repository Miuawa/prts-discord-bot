# Saves the narrator's current conversation before a manual restart.
#   logs\chat-logs\chat-<time>.md  full readable log (Discord messages, PRTS replies, terminal chat)
#   logs\restart-handoff.md         the last part of it, for the NEW session to read at start
# Reads the newest Claude Code transcript of this project. Run before daily-restart.ps1.
$root = Split-Path -Parent $PSScriptRoot
# Claude Code names a project's folder after its path, with every non-alphanumeric character replaced by '-'.
$rootFull = (Resolve-Path $root).Path
$proj = Join-Path $env:USERPROFILE ('.claude\projects\' + ($rootFull -replace '[^A-Za-z0-9]', '-'))
$src = Get-ChildItem $proj -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $src) { Write-Output 'No transcript found.'; exit 1 }

function Clip($s, $n) { if ($s.Length -gt $n) { $s.Substring(0, $n) + ' [...]' } else { $s } }

$entries = New-Object System.Collections.Generic.List[string]
foreach ($line in [System.IO.File]::ReadLines($src.FullName)) {
    try { $o = $line | ConvertFrom-Json } catch { continue }
    if ($o.type -ne 'user' -and $o.type -ne 'assistant') { continue }
    $c = $o.message.content
    $ts = if ($o.timestamp) { ([datetime]$o.timestamp).ToLocalTime().ToString('MM-dd HH:mm') } else { '' }
    if ($c -is [string]) {
        if ($o.type -eq 'user') { $entries.Add("[$ts] IN: " + (Clip $c 1500)) }
        continue
    }
    foreach ($b in $c) {
        if ($o.type -eq 'user' -and $b.type -eq 'text') { $entries.Add("[$ts] IN: " + (Clip $b.text 1500)) }
        elseif ($o.type -eq 'assistant' -and $b.type -eq 'text' -and $b.text.Trim()) { $entries.Add("[$ts] PRTS (terminal): " + (Clip $b.text 1500)) }
        elseif ($o.type -eq 'assistant' -and $b.type -eq 'tool_use' -and $b.name -eq 'mcp__discord__reply') {
            $entries.Add("[$ts] PRTS -> Discord: " + (Clip ([string]$b.input.text) 1500))
        }
    }
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$logDir = Join-Path $root 'logs\chat-logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "chat-$stamp.md"
$head = "# Narrator chat log, saved $stamp`nSource transcript: $($src.Name)`n`n"
Set-Content -Path $log -Value ($head + ($entries -join "`n`n")) -Encoding UTF8

# Handoff: newest entries that fit in ~12000 characters, oldest first.
$keep = New-Object System.Collections.Generic.List[string]
$size = 0
for ($i = $entries.Count - 1; $i -ge 0; $i--) {
    $size += $entries[$i].Length + 2
    if ($size -gt 12000) { break }
    $keep.Insert(0, $entries[$i])
}
$hand = "# Restart handoff`nsaved: $stamp`nfull log: $log`n`nThis is the end of the previous session's chat (older parts are in the full log). Continue from here.`n`n"
Set-Content -Path (Join-Path $root 'logs\restart-handoff.md') -Value ($hand + ($keep -join "`n`n")) -Encoding UTF8
Write-Output "Saved $log ($($entries.Count) entries)"
