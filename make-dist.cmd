@echo off
setlocal
set "MSYS2_ARG_CONV_EXCL=*"
rem ---------------------------------------------------------------------------
rem make-dist.cmd - build pbmcp.exe and assemble the self-contained dist/
rem
rem Usage:  make-dist.cmd
rem
rem Output layout:
rem   dist\pbmcp.exe
rem   dist\index-*.json       newest repo-root index-*.json copied verbatim -
rem                           a working docs-index drop-in (the loader's glob is
rem                           index-*.json; plain index.json is ignored). When
rem                           none exists the binary's embedded placeholder covers.
rem   dist\README.md
rem   dist\INSTALL.md
rem   dist\LICENSE
rem   dist\skills\purebasic\         complete skill (SKILL.md + references\)
rem
rem Builds in a sibling staging directory; the previous dist\ stays intact
rem until the new bundle builds, copies, and passes its acceptance suite.
rem ---------------------------------------------------------------------------
cd /d "%~dp0" || exit /b 1

rem Recover an old bundle left by an uncatchable interruption after its rename.
if not exist "%~dp0dist" for /d %%B in ("%~dp0.dist-stage-*.old") do if not exist "%~dp0dist" if exist "%%B\pbmcp.exe" if exist "%%B\index.json" if exist "%%B\README.md" (
    move "%%B" "%~dp0dist" >nul || echo make-dist: previous dist remains at "%%B"
    if not exist "%%B" rmdir /s /q "%%~dpB%%~nB"
)

set "STAGE_OWNED="
set "STAGE="
set "BACKUP="
set /a tries=0
:stage_try
set /a tries+=1
set "STAGE=%~dp0.dist-stage-%RANDOM%-%RANDOM%"
mkdir "%STAGE%" >nul 2>&1
if errorlevel 1 if %tries% LSS 10 goto :stage_try
if errorlevel 1 goto :no_stage
set "STAGE_OWNED=1"
set "BACKUP=%STAGE%.old"
mkdir "%STAGE%\skills\purebasic" || goto :fail

echo make-dist: assembling staged dist layout

echo make-dist: building pbmcp.exe
set "PBMCP_OUT=%STAGE%\pbmcp.exe"
call build.cmd
if errorlevel 1 (
    echo make-dist: build FAILED
    goto :fail
)

echo make-dist: copying docs + skill
copy /y "README.md"                 "%STAGE%\" >nul || goto :fail
copy /y "INSTALL.md"                "%STAGE%\" >nul || goto :fail
copy /y "LICENSE"                    "%STAGE%\" >nul || goto :fail
copy /y "src\pbdocs-index.json" "%STAGE%\index.json" >nul || goto :fail
echo make-dist: copying complete skill tree (SKILL.md + references\)
xcopy /e /i /y "skills\purebasic" "%STAGE%\skills\purebasic\" >nul || goto :fail

rem smoke: the artifact must launch (also warms it past first-run AV
rem scanning - a never-executed fresh exe can fail to start in time under
rem the suite's timing-sensitive tests)
echo make-dist: smoke - staged pbmcp.exe version
"%STAGE%\pbmcp.exe" version >nul 2>&1 || goto :fail

echo make-dist: testing staged pbmcp.exe
set "PBMCP_EXE=%STAGE%\pbmcp.exe"
node "%~dp0test\run_tests.mjs"
if errorlevel 1 goto :fail

rem Move the old bundle aside first; if Windows still has its exe locked,
rem this fails without deleting or changing dist\.
if exist "%~dp0dist" (
    if exist "%BACKUP%" goto :fail
    move "%~dp0dist" "%BACKUP%" >nul || goto :fail
)
move "%STAGE%" "%~dp0dist" >nul
if errorlevel 1 (
    goto :fail
)
set "STAGE_OWNED="
if exist "%BACKUP%" (
    rmdir /s /q "%BACKUP%" 2>nul
    if exist "%BACKUP%" echo make-dist: previous files remain at "%BACKUP%"
)

echo make-dist: OK
dir /b "dist" "dist\skills\purebasic"
endlocal
exit /b 0

:no_stage
echo make-dist: could not create a unique staging directory
exit /b 1

:fail
if defined BACKUP if exist "%BACKUP%" (
    if not exist "%~dp0dist" move "%BACKUP%" "%~dp0dist" >nul
    if exist "%BACKUP%" echo make-dist: previous dist remains at "%BACKUP%"
)
if defined STAGE_OWNED if exist "%STAGE%" rmdir /s /q "%STAGE%"
echo make-dist: assembly FAILED
exit /b 1
