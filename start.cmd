@echo off
title JARVIS
cd /d "%~dp0"
if not exist secrets mkdir secrets
node server\index.mjs
if errorlevel 1 pause