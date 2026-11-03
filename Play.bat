@echo off
start "" http://localhost:8777/
powershell -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
