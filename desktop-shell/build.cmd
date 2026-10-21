@echo off
setlocal
cd /d "%~dp0"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [error] csc.exe not found: %CSC%
  exit /b 1
)

if not exist "sdk\lib\Microsoft.Web.WebView2.Core.dll" (
  echo [error] WebView2 SDK reference assemblies missing, run fetch-sdk.cmd first
  exit /b 1
)

if exist dist rmdir /s /q dist
mkdir dist

"%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 ^
  /out:dist\RikkaHub.exe /win32icon:icon.ico /win32manifest:app.manifest ^
  /resource:icon.ico,RikkaHubIcon /resource:splash.html,RikkaHubSplash ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:sdk\lib\Microsoft.Web.WebView2.Core.dll /r:sdk\lib\Microsoft.Web.WebView2.WinForms.dll ^
  Program.cs
if errorlevel 1 exit /b 1

copy /y sdk\lib\Microsoft.Web.WebView2.Core.dll dist\ >nul
copy /y sdk\lib\Microsoft.Web.WebView2.WinForms.dll dist\ >nul
copy /y sdk\lib\WebView2Loader.dll dist\ >nul

echo.
echo Built dist\RikkaHub.exe
