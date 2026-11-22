[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')]
    [ValidatePattern('^COM[1-9][0-9]*$')]
    [string]$Port,

    [ValidateRange(1, 65535)]
    [int]$HubPort = 8080,

    [Parameter(Mandatory = $true, ParameterSetName = 'List')]
    [switch]$List
)

$ErrorActionPreference = 'Stop'
if ($List) {
    [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object
    return
}

$hub = [Uri]"ws://127.0.0.1:$HubPort/ws?role=device"
$encoding = [System.Text.Encoding]::UTF8
$textMessage = [System.Net.WebSockets.WebSocketMessageType]::Text

function Invoke-SeatSession($serial, $ws) {
    $serial.Open()
    $connectTimeout = [System.Threading.CancellationTokenSource]::new(4000)
    try {
        $ws.ConnectAsync($hub, $connectTimeout.Token).GetAwaiter().GetResult()
    } finally {
        $connectTimeout.Dispose()
    }
    Write-Host "Connected $Port at 115200 baud to Hub port $HubPort. Waiting for ESP32-C3."

    # A leading newline discards any partial frame left by an earlier session.
    $serial.WriteLine("")
    $serial.WriteLine('{"type":"serial.reconnect"}')
    $inputBuffer = ''
    $ready = $false
    $lastFrame = [System.Diagnostics.Stopwatch]::StartNew()
    $deviceTimeout = 15000
    $readBuffer = [byte[]]::new(4096)
    $readSegment = [ArraySegment[byte]]::new($readBuffer)
    $readTask = $ws.ReceiveAsync($readSegment, [System.Threading.CancellationToken]::None)
    $frame = [System.IO.MemoryStream]::new()
    try {
        while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $inputBuffer += $serial.ReadExisting()
            while (($newline = $inputBuffer.IndexOf("`n")) -ge 0) {
                $line = $inputBuffer.Substring(0, $newline).Trim()
                $inputBuffer = $inputBuffer.Substring($newline + 1)
                if (!$line.StartsWith('{') -or $line.Length -gt 1024) { continue }
                try { $message = ConvertFrom-Json -InputObject $line } catch { continue }
                if ($message.type -eq 'hello' -and $message.role -eq 'device' -and $message.seatId) {
                    $ready = $true
                    Write-Host "ESP32-C3 seat $($message.seatId) registered."
                } elseif (!$ready -or $message.type -notin @('button', 'sensor', 'ping')) {
                    continue
                }
                $lastFrame.Restart()
                $data = [ArraySegment[byte]]::new($encoding.GetBytes($line))
                $sendTimeout = [System.Threading.CancellationTokenSource]::new(4000)
                try {
                    $ws.SendAsync($data, $textMessage, $true, $sendTimeout.Token).GetAwaiter().GetResult()
                } finally {
                    $sendTimeout.Dispose()
                }
            }
            if ($inputBuffer.Length -gt 1024) { $inputBuffer = '' }
            if ($lastFrame.ElapsedMilliseconds -gt $deviceTimeout) {
                throw 'No serial frames from ESP32-C3. Check the USB connection and firmware.'
            }

            while ($readTask.IsCompleted) {
                $received = $readTask.GetAwaiter().GetResult()
                if ($received.MessageType -ne $textMessage) { return }
                $frame.Write($readBuffer, 0, $received.Count)
                if ($frame.Length -gt 4095) { throw 'Hub frame exceeds the ESP32-C3 serial buffer.' }
                if ($received.EndOfMessage) {
                    $line = $encoding.GetString($frame.ToArray())
                    $reply = ConvertFrom-Json -InputObject $line
                    if ($reply.type -in @('snapshot', 'config.update') -and $reply.config.heartbeatMs) {
                        $deviceTimeout = [Math]::Max(15000, 3 * [int]$reply.config.heartbeatMs)
                    }
                    $serial.WriteLine($line)
                    $frame.SetLength(0)
                }
                $readTask = $ws.ReceiveAsync($readSegment, [System.Threading.CancellationToken]::None)
            }
            Start-Sleep -Milliseconds 20
        }
    } finally {
        $frame.Dispose()
    }
}

while ($true) {
    $serial = [System.IO.Ports.SerialPort]::new($Port, 115200)
    $serial.Encoding = $encoding
    $serial.NewLine = "`n"
    $serial.DtrEnable = $true
    $serial.WriteTimeout = 2000
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        Invoke-SeatSession $serial $ws
    } catch {
        Write-Warning $_.Exception.Message
    } finally {
        $ws.Dispose()
        $serial.Dispose()
    }
    Write-Host 'Reconnecting in 2 seconds. Press Ctrl+C to stop.'
    Start-Sleep -Seconds 2
}
