@echo off
set "NODEDIR=C:\Program Files\nodejs"
set "LOCALBIN=%USERPROFILE%\.local\bin"
set "PATH=%NODEDIR%;%LOCALBIN%;%PATH%"
set "PORT=4567"

cd /d "%~dp0server"

if not exist "%NODEDIR%\node.exe" (
    echo [ERROR] Node.js not found at %NODEDIR%
    pause
    exit /b 1
)

:: 기존 node 프로세스 종료
taskkill /F /IM node.exe > nul 2>&1
timeout /t 1 /nobreak > nul

:: node_modules 없으면 설치
if not exist "node_modules" (
    echo [INFO] Installing packages...
    "%NODEDIR%\npm.cmd" install
)

echo.
echo  Starting server on port %PORT% ...
echo  Access: http://localhost:%PORT%
echo.

:: 브라우저를 3초 후에 열기 (별도 창)
start "" cmd /c "timeout /t 3 /nobreak > nul && start http://localhost:%PORT%"

:: 서버 실행 (이 창에서 직접 — 창 닫으면 서버도 종료)
"%NODEDIR%\node.exe" server.js

echo.
echo [Server stopped]
pause
