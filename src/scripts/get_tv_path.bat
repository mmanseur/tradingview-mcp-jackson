@echo off
wmic process where "name='TradingView.exe'" get ExecutablePath /format:list 2>nul
