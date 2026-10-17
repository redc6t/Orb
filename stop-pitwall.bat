@echo off
rem Stops any pit wall server or simulator still running in the background
rem (for example one left over from a closed window or a Claude session).
rem Only Node.js processes holding the pit wall ports are stopped:
rem   TCP 8080 server, 8081 Agile sim, 8082 Sentinel sim, UDP 47800 telemetry.
rem   stop-pitwall.bat [nopause]
cd /d "%~dp0"
echo Looking for a pit wall server or simulator still running...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ids = @(Get-NetTCPConnection -LocalPort 8080,8081,8082 -State Listen -ErrorAction SilentlyContinue | %% OwningProcess) + @(Get-NetUDPEndpoint -LocalPort 47800 -ErrorAction SilentlyContinue | %% OwningProcess);" ^
  "$procs = $ids | Sort-Object -Unique | %% { Get-CimInstance Win32_Process -Filter \"ProcessId=$_\" } | ? { $_.Name -eq 'node.exe' };" ^
  "if (-not $procs) { Write-Host '  Nothing running. All clear.'; exit 0 }" ^
  "foreach ($p in $procs) { Write-Host ('  Stopping PID ' + $p.ProcessId + ' (started ' + $p.CreationDate + '): ' + $p.CommandLine); Stop-Process -Id $p.ProcessId -Force }" ^
  "Start-Sleep -Milliseconds 500; Write-Host '  Done. The ports are free.'"
if /i not "%~1"=="nopause" pause
