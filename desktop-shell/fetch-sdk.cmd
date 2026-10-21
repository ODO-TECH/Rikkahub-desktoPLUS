@echo off
setlocal
cd /d "%~dp0"

REM NOTE: keep this file ASCII-only. cmd.exe decodes .cmd bytes in the console's
REM OEM codepage (GBK on zh-CN Windows), and a UTF-8 multi-byte character can
REM swallow the following quote/paren while parsing, breaking the script.

REM Fetch the three WebView2 reference assemblies into sdk\lib (~0.9 MB, build
REM input, never committed). Needs the curl.exe and tar.exe shipped with
REM Windows 10 1803+. If the network is blocked, download manually:
REM   https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4258.31
REM save it as sdk\wv2.zip and run this script again.

set "VER=1.0.4258.31"
set "URL=https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/%VER%"

if exist "sdk\lib\Microsoft.Web.WebView2.Core.dll" (
  echo [ok] sdk\lib already populated, nothing to do.
  exit /b 0
)

if not exist sdk mkdir sdk
if not exist "sdk\lib" mkdir "sdk\lib"

if not exist "sdk\wv2.zip" (
  echo [1/3] Downloading Microsoft.Web.WebView2 %VER% ...
  curl -L --fail -o "sdk\wv2.zip" "%URL%"
  if errorlevel 1 goto :fail
) else (
  echo [1/3] Using the sdk\wv2.zip you placed here manually
)

echo [2/3] Extracting the x64 reference assemblies ...
tar -xf "sdk\wv2.zip" -C sdk "lib/net462/Microsoft.Web.WebView2.Core.dll" "lib/net462/Microsoft.Web.WebView2.WinForms.dll" "build/native/x64/WebView2Loader.dll"
if errorlevel 1 goto :fail

move /y "sdk\lib\net462\Microsoft.Web.WebView2.Core.dll" "sdk\lib\" >nul
move /y "sdk\lib\net462\Microsoft.Web.WebView2.WinForms.dll" "sdk\lib\" >nul
move /y "sdk\build\native\x64\WebView2Loader.dll" "sdk\lib\" >nul
if exist "sdk\lib\net462" rmdir /s /q "sdk\lib\net462"
if exist sdk\build rmdir /s /q sdk\build
if exist "sdk\wv2.zip" del /q "sdk\wv2.zip"

echo [3/3] Done:
dir /b "sdk\lib"
echo Now run build.cmd to produce dist\RikkaHub.exe
exit /b 0

:fail
echo [error] Download or extraction failed. Retry, or drop sdk\wv2.zip manually.
exit /b 1
