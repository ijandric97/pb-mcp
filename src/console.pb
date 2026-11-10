; ---------------------------------------------------------------------------
; console.pb - UTF-8 console output + input loops (stdio transport).
;
; BOM-less UTF-8 is silently misread as CP-1252 by the PB compilers;
; build.cmd enforces the BOM via tools/lint_encoding.mjs.
; ---------------------------------------------------------------------------
EnableExplicit

XIncludeFile "scan_support.pb"

Declare HandleLine(Raw$, ControlOnly.i = #False)
Declare SendError(IdValue.i, Code.i, Message$)
Declare RunStdin(File.i = 0)
Declare PollControlMessages()

CompilerIf #PB_Compiler_OS = #PB_OS_Linux
; Raw read(2) for the stdin loop (see RunStdin) + dup/close for the capture
; below. Measured live on WSL/6.41 (port Phase 2): ReadConsoleData on a piped
; stdin waits for the FULL requested count before returning (same "waits for
; requested size" semantics the test suite already documents for
; ReadProgramData) and blocks at EOF instead of returning 0 - interactive
; sessions never saw a response until stdin closed, and a closed stdin never
; terminated the loop (file mode and one-big-write pipe mode were unaffected).
; read(2) has exactly the semantics the loop needs: returns what is available
; (short reads), 0 = EOF, -1 = error (EINTR -> retry).
;
; AND, the second live finding (strace, WSL/6.41): PB's Linux OpenConsole()
; does dup(0) -> internal console fd, then CLOSES fd 0 outright. Every read
; on fd 0 after that is EBADF (or worse - fd 0 gets recycled by unrelated
; opens from other threads; the trace showed a directory landing on 0 and
; read(0) failing EISDIR). So the loop must NOT read fd 0 at all: main.pb
; calls StdinCapture() BEFORE OpenConsole(), we dup our own handle while fd 0
; is still the client's pipe, and RunStdin reads that saved fd. dup returns
; the lowest free fd; we store the actual number, no fixed-fd assumptions.
; Imported under aliases because 'Read' is a PB keyword; ImportC "" adds no
; link flags - the symbols resolve from the libc every PB Linux binary links.
; fasm (the PB Linux assembler backend) treats 'dup' as a reserved word -
; ImportC As "dup" emits 'extrn dup' and the assembly step fails. fcntl
; F_DUPFD does the same job (duplicate fd to the LOWEST free fd >= arg,
; exactly dup's contract) and is a plain libc symbol. F_DUPFD = 0 on Linux.
#F_DUPFD = 0
ImportC ""
  StdinRead(fd.i, *buf, count.i) As "read"
  StdinDupFd(fd.i, cmd.i, arg.i) As "fcntl"
  StdinClose(fd.i) As "close"
  StdinPoll(*fds, count.i, timeout.l) As "poll"
EndImport

Structure StdinPollFdT
  fd.l
  events.w
  revents.w
EndStructure

Global gStdinFd.i = -1
CompilerEndIf

; MUST run before OpenConsole() (see the block above for why). Windows: a
; no-op - the Windows build keeps reading fd 0 via ReadConsoleData, exactly
; as before the Linux port. -1 = capture failed (fd 0 already closed at
; startup); RunStdin then degenerates to a quick clean EOF exit.
Procedure StdinCapture()
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    gStdinFd = StdinDupFd(0, #F_DUPFD, 0)
  CompilerEndIf
EndProcedure

; Golden-session mode: one client message per line, responses to stdout.
; Missing file -> stderr note + exit code 1 (this is a test runner).
Procedure RunFile(Path$)
  Protected f.i = ReadFile(#PB_Any, Path$)
  If f = 0
    ConsoleError("pbmcp: cannot open session file: " + Path$)
    End 1
  EndIf
  RunStdin(f)
  CloseFile(f)
EndProcedure

#STDIN_CHUNK = 65536
#MAX_FRAME_BYTES = 1048576

Structure InputFrameT
  text.s
  error.s
EndStructure

Global gInputActive.i, gInputFile.i, gInputEof.i, gInputDiscarding.i
Global *gInputBuffer, gInputCapacity.i, gInputLength.i, gInputScan.i, gInputErrors.i
Global NewList gPendingInput.InputFrameT()
Global gPendingInputChars.i

Procedure.i QueueInput(Text$, Error$ = "")
  If Text$ = "" And Error$ = "" : ProcedureReturn #True : EndIf
  If gPendingInputChars + Len(Text$) + Len(Error$) > #MAX_FRAME_BYTES : ProcedureReturn #False : EndIf
  LastElement(gPendingInput())
  AddElement(gPendingInput())
  gPendingInput()\text = Text$
  gPendingInput()\error = Error$
  gPendingInputChars + Len(Text$) + Len(Error$)
  ProcedureReturn #True
EndProcedure

Procedure.s RequestBytesError(*Buffer, Bytes.i)
  Protected i.i, c.i, remaining.i, minimum.i = $80, maximum.i = $BF
  For i = 0 To Bytes - 1
    c = PeekA(*Buffer + i)
    If c = 0
      ProcedureReturn "NUL bytes are not supported in request lines"
    EndIf
    If remaining
      If c < minimum Or c > maximum : Break : EndIf
      remaining - 1 : minimum = $80 : maximum = $BF
    ElseIf c >= $80
      ; Constrain the second byte to exclude overlong forms, surrogates and values above U+10FFFF.
      Select c
        Case $C2 To $DF : remaining = 1
        Case $E0 : remaining = 2 : minimum = $A0
        Case $E1 To $EC, $EE To $EF : remaining = 2
        Case $ED : remaining = 2 : maximum = $9F
        Case $F0 : remaining = 3 : minimum = $90
        Case $F1 To $F3 : remaining = 3
        Case $F4 : remaining = 3 : maximum = $8F
        Default : Break
      EndSelect
    EndIf
  Next
  If i < Bytes Or remaining
    ProcedureReturn "Request line is not valid UTF-8"
  EndIf
  ProcedureReturn ""
EndProcedure

Procedure DecodeInputFrame(*frame.InputFrameT, Bytes.i)
  While Bytes > 0 And PeekA(*gInputBuffer + Bytes - 1) = 13 : Bytes - 1 : Wend
  *frame\error = RequestBytesError(*gInputBuffer, Bytes)
  If *frame\error <> "" : ProcedureReturn : EndIf
  If Bytes > 0 : *frame\text = PeekS(*gInputBuffer, Bytes, #PB_UTF8 | #PB_ByteLength) : EndIf
EndProcedure

; One complete frame, zero when polling would block, or -1 at EOF.
Procedure.i ReadInputFrame(*frame.InputFrameT, Wait.i)
  Protected i.i, consumed.i, n.i, available.i, ready.i
  *frame\text = "" : *frame\error = ""
  Repeat
    consumed = 0
    For i = gInputScan To gInputLength - 1
      If PeekA(*gInputBuffer + i) = 10
        ready = Bool(Not gInputDiscarding)
        If ready
          If i > #MAX_FRAME_BYTES
            *frame\error = "Request line exceeds 1048576 bytes"
          Else
            DecodeInputFrame(*frame, i)
          EndIf
        EndIf
        consumed = i + 1
        MoveMemory(*gInputBuffer + consumed, *gInputBuffer, gInputLength - consumed)
        gInputLength - consumed : gInputScan = 0 : gInputDiscarding = #False
        If ready : ProcedureReturn 1 : EndIf
        Break
      EndIf
    Next
    If consumed : Continue : EndIf
    gInputScan = gInputLength
    If gInputLength > #MAX_FRAME_BYTES And Not gInputDiscarding
      gInputDiscarding = #True
      gInputLength = 0 : gInputScan = 0
      *frame\error = "Request line exceeds 1048576 bytes"
      ProcedureReturn 1
    EndIf
    If gInputDiscarding : gInputLength = 0 : gInputScan = 0 : EndIf
    If gInputEof
      If gInputLength > 0
        DecodeInputFrame(*frame, gInputLength)
        gInputLength = 0 : gInputScan = 0
        ProcedureReturn 1
      EndIf
      ProcedureReturn -1
    EndIf
    If gInputLength >= gInputCapacity
      gInputCapacity * 2
      If gInputCapacity > #MAX_FRAME_BYTES + 1 : gInputCapacity = #MAX_FRAME_BYTES + 1 : EndIf
      Protected *grown = ReAllocateMemory(*gInputBuffer, gInputCapacity)
      If *grown = 0 : End 1 : EndIf
      *gInputBuffer = *grown
    EndIf
    available = gInputCapacity - gInputLength
    If gInputFile
      n = ReadData(gInputFile, *gInputBuffer + gInputLength, available)
    Else
      CompilerIf #PB_Compiler_OS = #PB_OS_Windows
        If Not Wait
          Protected handle.i = GetStdHandle_(#STD_INPUT_HANDLE), bytes.l, kind.i = GetFileType_(handle)
          If kind = #FILE_TYPE_PIPE
            If PeekNamedPipe_(handle, 0, 0, 0, @bytes, 0) = 0
              gInputEof = #True : Continue
            EndIf
            If bytes <= 0 : ProcedureReturn 0 : EndIf
            If available > bytes : available = bytes : EndIf
          ElseIf kind <> #FILE_TYPE_DISK
            ProcedureReturn 0
          EndIf
        EndIf
        n = ReadConsoleData(*gInputBuffer + gInputLength, available)
      CompilerElse
        If Not Wait
          Protected poll.StdinPollFdT
          poll\fd = gStdinFd : poll\events = 1 ; POLLIN; HUP also permits the EOF read.
          If StdinPoll(@poll, 1, 0) <= 0 : ProcedureReturn 0 : EndIf
        EndIf
        n = StdinRead(gStdinFd, *gInputBuffer + gInputLength, available)
      CompilerEndIf
    EndIf
    If n > 0
      gInputLength + n : gInputErrors = 0
    ElseIf n = 0
      gInputEof = #True
    Else
      gInputErrors + 1
      If gInputErrors > 64 : gInputEof = #True : EndIf
      If Not Wait : ProcedureReturn 0 : EndIf
      Delay(5)
    EndIf
    If Not Wait And gInputDiscarding : ProcedureReturn 0 : EndIf
  ForEver
EndProcedure

Procedure RunStdin(File.i = 0)
  gInputActive = #True : gInputFile = File : gInputEof = #False
  gInputCapacity = #STDIN_CHUNK : gInputLength = 0 : gInputScan = 0
  gInputDiscarding = #False : gInputErrors = 0
  *gInputBuffer = AllocateMemory(gInputCapacity)
  If *gInputBuffer = 0 : End 1 : EndIf
  Protected frame.InputFrameT, status.i
  Repeat
    If FirstElement(gPendingInput())
      frame\text = gPendingInput()\text : frame\error = gPendingInput()\error
      gPendingInputChars - Len(frame\text) - Len(frame\error)
      DeleteElement(gPendingInput())
      status = 1
    Else
      status = ReadInputFrame(@frame, #True)
    EndIf
    If status = 1
      If frame\error <> ""
        SendError(0, -32600, frame\error)
      Else
        HandleLine(frame\text)
      EndIf
    EndIf
  Until status = -1
  gInputActive = #False
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    If File = 0 And gStdinFd >= 0
      StdinClose(gStdinFd) : gStdinFd = -1
    EndIf
  CompilerEndIf
  FreeMemory(*gInputBuffer) : *gInputBuffer = 0
EndProcedure
