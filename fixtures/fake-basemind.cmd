@echo off
rem Test-only launcher: pretends to be BaseMind 0.34.0 and forwards real work.
if /I %1==--version (
  echo basemind 0.34.0
  exit /b 0
)
if /I %1==serve (
  node "%~dp0fake-mcp-server.mjs" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0fake-basemind-cli.mjs" %*
exit /b %ERRORLEVEL%
