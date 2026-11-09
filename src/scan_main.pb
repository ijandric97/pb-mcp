; Minimal executable used only to build docs indexes.
EnableExplicit
#PBMCP_BATCH_SCANNER = #True

XIncludeFile "scan_support.pb"
XIncludeFile "html_scan.pb"

If OpenConsole() = 0 : End 1 : EndIf
RunScanBatchMode()
CloseConsole()
