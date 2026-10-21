@echo off
setlocal
REM NOTE: keep this file ASCII-only with CRLF line endings (cmd.exe decodes .cmd
REM bytes in the console OEM codepage, so UTF-8 text and lone LF can break parsing).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > nul
set CARGO_TARGET_DIR=C:\rikkahub-build
cd /d "%~dp0"
REM Resolve cargo from rustup's home instead of hardcoding one machine's user profile.
if defined CARGO_HOME (call "%CARGO_HOME%\bin\cargo.exe" %*) else (call "%USERPROFILE%\.cargo\bin\cargo.exe" %*)
exit /b %errorlevel%
