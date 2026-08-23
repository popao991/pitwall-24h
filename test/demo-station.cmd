@echo off
rem Second copy of the app on the same PC, for a station beside the pit wall
rem (demo / test-day use). Its own userData folder keeps it from fighting the
rem pit wall copy over the Chromium profile. Pick a car, leave the IP empty
rem (= 127.0.0.1, the pit wall on this PC) and press START STATION.
set PITWALL_USER_DATA=%LOCALAPPDATA%\pitwall-demo-station
cd /d "%~dp0.."
npm start
