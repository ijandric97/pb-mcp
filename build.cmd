@echo off
setlocal
rem ---------------------------------------------------------------------------
rem build.cmd - build with the installed PureBasic compiler and matching help.
rem
rem Usage:  build.cmd         lint + compile pbmcp.exe
rem         build.cmd check   thread-safe /CHECK on the complete source tree
rem
rem Paths are absolute (%~dp0); no shell mangling possible under cmd.exe.
rem MSYS2_ARG_CONV_EXCL additionally guards /SWITCH args when this script is
rem driven from a Git-Bash/MSYS shell; harmless under plain cmd.
rem ---------------------------------------------------------------------------
set "MSYS2_ARG_CONV_EXCL=*"

set "PBC="
if defined PUREBASIC_HOME if exist "%PUREBASIC_HOME%Compilers\pbcompiler.exe" set "PBC=%PUREBASIC_HOME%Compilers\pbcompiler.exe"
if not defined PBC if defined PUREBASIC_HOME if exist "%PUREBASIC_HOME%\Compilers\pbcompiler.exe" set "PBC=%PUREBASIC_HOME%\Compilers\pbcompiler.exe"
if not defined PBC if exist "%ProgramFiles(x86)%\PureBasic\Compilers\pbcompiler.exe" set "PBC=%ProgramFiles(x86)%\PureBasic\Compilers\pbcompiler.exe"
if not defined PBC if exist "%ProgramFiles%\PureBasic\Compilers\pbcompiler.exe" set "PBC=%ProgramFiles%\PureBasic\Compilers\pbcompiler.exe"
if not defined PBC if exist "C:\PureBasic\Compilers\pbcompiler.exe" set "PBC=C:\PureBasic\Compilers\pbcompiler.exe"
if not defined PBC if exist "%LOCALAPPDATA%\Programs\PureBasic\Compilers\pbcompiler.exe" set "PBC=%LOCALAPPDATA%\Programs\PureBasic\Compilers\pbcompiler.exe"
if not defined PBC (
    echo build.cmd: pbcompiler.exe not found - set PUREBASIC_HOME to the PureBasic installation
    exit /b 1
)

echo build.cmd: encoding lint - UTF-8 BOM required on all src/*.pb
node "%~dp0tools\lint_encoding.mjs"
if errorlevel 1 (
    echo build.cmd: lint FAILED - fix source encoding before compiling
    exit /b 1
)

set "SRC=%~dp0src\main.pb"
rem PBMCP_OUT overrides the output path (make-dist.cmd builds straight into
rem dist\ so a running server cannot lock the target exe)
if defined PBMCP_OUT (set "OUT=%PBMCP_OUT%") else set "OUT=%~dp0pbmcp.exe"

if /i not "%~1"=="check" goto compile

echo build.cmd: /CHECK on "%SRC%"
"%PBC%" /THREAD /CHECK "%SRC%"
exit /b %errorlevel%

:compile
set "REVISION=unknown"
node "%~dp0tools\build-local-index.mjs" --compiler "%PBC%" --out "%~dp0src\pbdocs-index.json"
if errorlevel 1 (
    echo build.cmd: local help indexing FAILED - Node.js and matching installed help are required
    exit /b 1
)
for /f "delims=" %%G in ('git -C "%~dp0." rev-parse --short HEAD 2^>nul') do set "REVISION=%%G"
if not "%REVISION%"=="unknown" (
    git -C "%~dp0." diff --quiet HEAD -- 2>nul
    if errorlevel 1 set "REVISION=%REVISION%-dirty"
)
echo build.cmd: compiling "%SRC%"
"%PBC%" /THREAD /CONSOLE "%SRC%" /EXE "%OUT%" /CONSTANT PBMCP_REVISION$=%REVISION%
if errorlevel 1 (
    echo build.cmd: compile FAILED
    exit /b 1
)
echo build.cmd: OK - "%OUT%"
endlocal
