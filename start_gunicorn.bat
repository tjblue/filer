@echo off
REM Start Filer with Gunicorn on Windows
REM
REM Usage:
REM   start_gunicorn.bat [root_directory] [port] [host]
REM
REM Examples:
REM   start_gunicorn.bat                    REM Use defaults (current dir, port 5000, 0.0.0.0)
REM   start_gunicorn.bat C:\files           REM Serve specific directory
REM   start_gunicorn.bat . 8080             REM Use port 8080
REM   start_gunicorn.bat . 8080 127.0.0.1   REM Bind to localhost only

REM Default values
set "ROOT_DIR=%~1"
set "PORT=%~2"
set "HOST=%~3"

if "%ROOT_DIR%"=="" set "ROOT_DIR=."
if "%PORT%"=="" set "PORT=5000"
if "%HOST%"=="" set "HOST=0.0.0.0"

REM Export environment variables
set "FILER_ROOT=%ROOT_DIR%"
set "FILER_PORT=%PORT%"

REM Display configuration
echo =========================================
echo Starting Filer with Gunicorn
echo =========================================
echo Root Directory: %FILER_ROOT%
echo Binding to: %HOST%:%PORT%
echo Workers: 2
echo Threads per worker: 2
echo =========================================
echo.

REM Start Gunicorn
gunicorn --config gunicorn_config.py --bind %HOST%:%PORT% wsgi:application
