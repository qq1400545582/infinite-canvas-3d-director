@echo off
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo ========================================
echo   StoryAI 3D Director Desk - Package Tool
echo ========================================
echo.

echo [0/4] Cleaning old files...
if exist "release" (
    rmdir /s /q "release" 2>nul
    if exist "release" (
        echo Cannot delete release folder, please close any running exe first
        pause
        exit /b 1
    )
)
if exist "node_modules\electron" (
    rmdir /s /q "node_modules\electron" 2>nul
)

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo Install failed!
    pause
    exit /b 1
)

echo.
echo [2/4] Building frontend...
call npm run build
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)

echo.
echo [3/4] Packaging to exe...
call npx electron-builder --win
if errorlevel 1 (
    echo Package failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done! Check release folder for exe
echo ========================================
pause
