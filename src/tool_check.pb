; ---------------------------------------------------------------------------
; tool_check.pb - pb_check implementation + the SHARED compiler pipeline.
;
; Compiler-diagnostics parsing, banner filtering, the check/run process
; pipelines, the formatting helpers both compiler tools need (truncation/
; collapse rules) and the pb_check-specific error hints.
;
; Shared formatting, process capture, and temporary output management live
; here because tool_run.pb is included after this file.
;
; Pipeline semantics:
;   - compile the original source path so relative includes and resources resolve
;   - the user's source file is NEVER modified; output stays in a temp directory
;   - compiler cwd = the temp dir (5.73 drops stray artifacts into cwd)
;   - /CHECK: syntax check only; /CONSOLE /EXE <abs>: build without launching
;     (5.73's plain /CONSOLE auto-launches the program - the orphan that
;     motivated the whole pipeline; verified harmless-but-correct on 6.40)
;   - one retry for the known assembler write failure caused by file locks
;   - per-run jobs/groups terminate contained descendants on success, timeout, or server exit
;   - temp dir always cleaned (retry with backoff; fresh exes are briefly
;     AV-locked); cleanup failure is never surfaced
;
; Source-encoding rule: UTF-8 WITH BOM (see console.pb header).
; ---------------------------------------------------------------------------
EnableExplicit

; ---------------------------------------------------------------------------
; shared formatting helpers
; ---------------------------------------------------------------------------
#SEARCH_CAP        = 8000
#COMMAND_CAP       = 14000
#REMARKS_CAP       = 1200
#EXAMPLE_KEEP_LINES = 20
#CHECK_CAP         = 8000
#RUN_SECTION_CAP   = 10000
#CHECK_TIMEOUT_MS  = 15000
#COMPILE_TIMEOUT_MS = 30000
#DEFAULT_RUN_TIMEOUT_MS = 15000
#MAX_RUN_TIMEOUT_MS = 60000
#MAX_CAPTURE_CHARS = 4194304   ; 4 MB byte capture guard per stream
#CAPTURE_SPIN_MS = 5           ; poll flat out briefly after output arrives
#MAX_LINT_SOURCE_BYTES = 512 * 1024

; JS String.trim(): PB Trim/LTrim/RTrim accept one character, not a set.
Procedure.s TrimAll(Text$)
  Protected ws$ = " " + Chr(9) + Chr(10) + Chr(13) + Chr(11) + Chr(12)
  ws$ + Chr($A0) + Chr($1680) + Chr($2028) + Chr($2029) + Chr($202F) + Chr($205F) + Chr($3000) + Chr($FEFF)
  Protected i.i
  For i = $2000 To $200A : ws$ + Chr(i) : Next
  Protected first.i = 1, last.i = Len(Text$)
  While first <= last And FindString(ws$, Mid(Text$, first, 1))
    first + 1
  Wend
  While last >= first And FindString(ws$, Mid(Text$, last, 1))
    last - 1
  Wend
  ProcedureReturn Mid(Text$, first, last - first + 1)
EndProcedure

; oneLine whitespace set: space, tab, LF, CR, VT, FF (NOT the JS-trim set of
; TrimAll above). Macro arg is used 6x - only ever pass a plain variable (c$).
Macro IsWsChar(C)
  (C = " " Or C = Chr(9) Or C = Chr(10) Or C = Chr(13) Or C = Chr(11) Or C = Chr(12))
EndMacro

; One-line Text$, stopping once CapLen chars are emitted (0 = uncapped);
; *Capped = #True when the full one-lined text would be longer than CapLen.
; Span appends: one Mid() per non-whitespace run instead of per character.
; Parity-proven against the old per-char version
; (940,783 exhaustive/boundary/random comparisons).
Procedure.s OneLineCap(Text$, CapLen.i, *Capped.Integer)
  Protected out$ = "", i.i = 1, n.i = Len(Text$), j.i, c$, skipped.i
  *Capped\i = #False
  While i <= n
    ; skip one whitespace run
    skipped = #False
    While i <= n
      c$ = Mid(Text$, i, 1)
      If IsWsChar(c$)
        skipped = #True
        i + 1
      Else
        Break
      EndIf
    Wend
    If i > n : Break : EndIf
    If skipped And out$ <> "" : out$ + " " : EndIf
    ; append the non-whitespace run Text$[i .. j-1] in one Mid()
    j = i + 1
    While j <= n
      c$ = Mid(Text$, j, 1)
      If IsWsChar(c$) : Break : EndIf
      j + 1
    Wend
    out$ + Mid(Text$, i, j - i)
    i = j
    If CapLen > 0 And Len(out$) >= CapLen
      *Capped\i = #True
      Break
    EndIf
  Wend
  ProcedureReturn out$
EndProcedure

; Collapse whitespace runs to single spaces, trim.
Procedure.s OneLine(Text$)
  Protected capped.i
  ProcedureReturn OneLineCap(Text$, 0, @capped)
EndProcedure

Procedure.s SafePrefix(Text$, Max.i)
  If Max > 0 And Max < Len(Text$)
    Protected last.i = PeekU(@Text$ + (Max - 1) * SizeOf(Character))
    Protected following.i = PeekU(@Text$ + Max * SizeOf(Character))
    If last >= $D800 And last <= $DBFF And following >= $DC00 And following <= $DFFF : Max - 1 : EndIf
  EndIf
  ProcedureReturn Left(Text$, Max)
EndProcedure

; First sentence, capped at ~max chars with an ellipsis (= firstSentence).
; Early cap: only the first Max+1 one-lined chars can influence the result,
; so the one-lining stops there instead of processing the whole text.
Procedure.s FirstSentence(Text$, Max.i = 60)
  Protected capped.i
  Protected line$ = OneLineCap(Text$, Max + 1, @capped)
  If line$ = "" : ProcedureReturn "" : EndIf
  Protected endPos.i = FindString(line$, ". ", 1)
  If capped
    ; the full one-lined text is longer than Max: either the sentence ends
    ; within the first Max chars (endPos <= Max, so it is inside the window)
    ; or the Max-1 truncation with ellipsis applies
    If endPos > 0 And endPos <= Max : ProcedureReturn Left(line$, endPos) : EndIf
    ProcedureReturn RTrim(SafePrefix(line$, Max - 1)) + "…"
  EndIf
  ; uncapped: |line$| <= Max, so |sentence$| <= Max - never truncated
  Protected sentence$
  If endPos = 0
    sentence$ = line$
  Else
    sentence$ = Left(line$, endPos)
  EndIf
  ProcedureReturn sentence$
EndProcedure

; Hard-cap text, marking how much was dropped (= cap).
Procedure.s CapText(Text$, Max.i)
  If Len(Text$) <= Max : ProcedureReturn Text$ : EndIf
  Protected prefix$ = SafePrefix(Text$, Max)
  ProcedureReturn prefix$ + Chr(10) + "… [+" + Str(Len(Text$) - Len(prefix$)) + " chars truncated]"
EndProcedure

; Collapse long examples by LINES (= collapseLines, keep default 20).
Procedure.s CollapseLines(Text$, Keep.i = #EXAMPLE_KEEP_LINES)
  Protected nLines.i = CountString(Text$, Chr(10)) + 1
  If nLines <= Keep : ProcedureReturn Text$ : EndIf
  Protected out$ = StringField(Text$, 1, Chr(10))
  Protected i.i
  For i = 2 To Keep
    out$ + Chr(10) + StringField(Text$, i, Chr(10))
  Next
  ProcedureReturn out$ + Chr(10) + "… [+" + Str(nLines - Keep) + " lines collapsed]"
EndProcedure

; ---------------------------------------------------------------------------
; banner boilerplate filter (capability-flagged: 6.40 output is silent,
; so the filter only ever fires on the 5.73 fallback branch)
; ---------------------------------------------------------------------------
Procedure.i IsBannerLine(Line$)
  If Not ConfigCapBannerFilter() : ProcedureReturn #False : EndIf
  Protected t$ = Trim(Line$)
  If t$ = "" : ProcedureReturn #False : EndIf   ; blank lines: collapse logic, not banner
  If Left(t$, 10) = "**********" : ProcedureReturn #True : EndIf
  If Left(t$, 10) = "PureBasic " And Mid(t$, 11, 1) >= "0" And Mid(t$, 11, 1) <= "9" : ProcedureReturn #True : EndIf
  If Left(t$, 10) = "Compiling " : ProcedureReturn #True : EndIf
  If Left(t$, 16) = "Loading external" : ProcedureReturn #True : EndIf
  If Left(t$, 21) = "Starting compilation" : ProcedureReturn #True : EndIf
  If Left(t$, 19) = "Creating executable" : ProcedureReturn #True : EndIf
  If Left(t$, 32) = "Creating and launching executable" : ProcedureReturn #True : EndIf
  If Left(t$, 10) = "- Feel the" : ProcedureReturn #True : EndIf
  ProcedureReturn #False
EndProcedure

; stripCompilerNoise: drop banner lines, collapse blank runs, trim.
Procedure.s StripCompilerNoise(Output$)
  ; Reserve one extra LF for an unterminated final line and copy each kept line once.
  Protected length.i = Len(Output$), kept$ = Space(length + 1), written.i, lineLength.i
  Protected prevBlank.i = #True, start.i, nextLine.i, line$, t$
  While start < length
    nextLine = start
    While nextLine < length And PeekU(@Output$ + nextLine * SizeOf(Character)) <> 10
      nextLine + 1
    Wend
    line$ = RTrim(Trim(PeekS(@Output$ + start * SizeOf(Character), nextLine - start, #PB_Unicode)), Chr(13))
    start = nextLine + 1
    t$ = Trim(line$)
    If t$ <> "" And IsBannerLine(t$) : Continue : EndIf
    If t$ = "" And prevBlank : Continue : EndIf
    lineLength = Len(line$)
    If lineLength > 0 : CopyMemory(@line$, @kept$ + written * SizeOf(Character), lineLength * SizeOf(Character)) : EndIf
    written + lineLength
    PokeU(@kept$ + written * SizeOf(Character), 10)
    written + 1
    prevBlank = Bool(t$ = "")
  Wend
  ProcedureReturn TrimAll(Left(kept$, written))
EndProcedure

; ---------------------------------------------------------------------------
; parse compiler diagnostics
; ---------------------------------------------------------------------------
Structure DiagT
  line.i      ; 1-based source line, 0 when the compiler reported none
  message.s
  file.s      ; included source, empty for the main source
EndStructure

Global Dim gDiagRe.i(4)
Global gDiagReady.i = #False

; Group captures of the last ReMatch() call. GOTCHA FOUND LIVE ON 6.40:
; RegularExpressionGroup() is only valid after ExamineRegularExpression() +
; NextRegularExpressionMatch() - MatchRegularExpression() matches but leaves
; the group state empty, so every diagnostic parsed as "Line 0:" with an
; EMPTY message (silently, no compile error). All group extraction in this
; file goes through ReMatch(); bare MatchRegularExpression() stays in use
; only where the result is a pure boolean (hint lints, metrics classifier).
Global gReG1.s
Global gReG2.s

; PB regex offsets count Unicode code points; Mid() needs UTF-16 code units.
Procedure.s RegexGroupText(Re.i, Text$, Group.i)
  Protected first.i = RegularExpressionMatchPosition(Re) + RegularExpressionGroupPosition(Re, Group) - 1
  Protected count.i = RegularExpressionGroupLength(Re, Group)
  If first < 1 Or count <= 0 : ProcedureReturn "" : EndIf
  Protected finish.i = first + count, character.i = 1, unit.i = 1, start.i = 1
  Protected units.i = Len(Text$), code.i
  While character < finish And unit <= units
    If character = first : start = unit : EndIf
    code = PeekU(@Text$ + (unit - 1) * SizeOf(Character))
    If code >= $D800 And code <= $DBFF And unit < units
      code = PeekU(@Text$ + unit * SizeOf(Character))
      If code >= $DC00 And code <= $DFFF : unit + 1 : EndIf
    EndIf
    unit + 1 : character + 1
  Wend
  ProcedureReturn Mid(Text$, start, unit - start)
EndProcedure

; Match Text$ against Re (must be a compiled #PB_Any regex); on a match fill
; gReG1/gReG2 with groups 1/2 ("" when the group does not exist). Returns the
; match result. Only the FIRST match of a single-line pattern is needed here
; (the diagnostic rules are anchored ^...$ over one raw line).
Procedure.i ReMatch(Re.i, Text$)
  gReG1 = "" : gReG2 = ""
  If Re = 0 : ProcedureReturn #False : EndIf
  Protected matched.i = #False
  If ExamineRegularExpression(Re, Text$)
    If NextRegularExpressionMatch(Re)
      matched = #True
      If CountRegularExpressionGroups(Re) >= 1 : gReG1 = RegexGroupText(Re, Text$, 1) : EndIf
      If CountRegularExpressionGroups(Re) >= 2 : gReG2 = RegexGroupText(Re, Text$, 2) : EndIf
    EndIf
  EndIf
  ProcedureReturn matched
EndProcedure

Procedure DiagRulesInit()
  ; "Error: Line 2 - msg." / "Error: msg." / warning variants - PCRE verbatim
  gDiagRe(0) = CreateRegularExpression(#PB_Any, "^(?:Error: )?Line (\d+) - (.+?)\.?$")
  gDiagRe(1) = CreateRegularExpression(#PB_Any, "^Error: (.+?)\.?$")
  gDiagRe(2) = CreateRegularExpression(#PB_Any, "^Warning: Line (\d+) - (.+?)\.?$")
  gDiagRe(3) = CreateRegularExpression(#PB_Any, "^Warning: (.+)$")
  gDiagRe(4) = CreateRegularExpression(#PB_Any, "^Error: in included file '(.+)'$")
  gDiagReady = #True
EndProcedure

Procedure ParseDiagnostics(Output$, List Errors.DiagT(), List Warnings.DiagT())
  If Not gDiagReady : DiagRulesInit() : EndIf
  ClearList(Errors())
  ClearList(Warnings())
  Protected start.i, nextLine.i, length.i = Len(Output$), raw$, includedFile$
  While start < length
    nextLine = start
    While nextLine < length And PeekU(@Output$ + nextLine * SizeOf(Character)) <> 10
      nextLine + 1
    Wend
    raw$ = Trim(RTrim(Trim(PeekS(@Output$ + start * SizeOf(Character), nextLine - start, #PB_Unicode)), Chr(13)))
    start = nextLine + 1
    If raw$ = "" : Continue : EndIf
    If ReMatch(gDiagRe(4), raw$)
      includedFile$ = gReG1
      Continue
    EndIf
    If ReMatch(gDiagRe(0), raw$)
      AddElement(Errors())
      Errors()\line = Val(gReG1)
      Errors()\message = gReG2
      Errors()\file = includedFile$
      includedFile$ = ""
    ElseIf ReMatch(gDiagRe(1), raw$)
      AddElement(Errors())
      Errors()\line = 0
      Errors()\message = gReG1
    ElseIf ReMatch(gDiagRe(2), raw$)
      AddElement(Warnings())
      Warnings()\line = Val(gReG1)
      Warnings()\message = gReG2
    ElseIf ReMatch(gDiagRe(3), raw$)
      AddElement(Warnings())
      Warnings()\line = 0
      Warnings()\message = gReG1
    EndIf
  Wend
EndProcedure

; Linker/assembler details can follow a generic error without a source line.
Procedure.i DiagnosticsNeedRaw(List Errors.DiagT())
  If ListSize(Errors()) = 0 : ProcedureReturn #True : EndIf
  ForEach Errors()
    If Errors()\line = 0 : ProcedureReturn #True : EndIf
  Next
  ProcedureReturn #False
EndProcedure

Procedure.s FormatWarnings(List Warnings.DiagT())
  If ListSize(Warnings()) = 0 : ProcedureReturn "" : EndIf
  Protected out$ = Chr(10) + "Warnings (" + Str(ListSize(Warnings())) + "):", shown.i
  ForEach Warnings()
    If shown >= 40 : Break : EndIf
    out$ + Chr(10) + "Line " + Str(Warnings()\line) + ": " + Warnings()\message
    If Warnings()\file <> "" : out$ + " (in " + Warnings()\file + ")" : EndIf
    shown + 1
  Next
  If ListSize(Warnings()) > shown
    out$ + Chr(10) + "… +" + Str(ListSize(Warnings()) - shown) + " more warnings"
  EndIf
  ProcedureReturn CapText(out$, 4000)
EndProcedure

; ---------------------------------------------------------------------------
; process runner (no shell, capture, timeout, tree-kill)
; ---------------------------------------------------------------------------
Structure RunResT
  spawnFailed.i       ; RunProgram could not start the exe
  exitCodeUnknown.i   ; killed-then-stuck panic path: no code ever observed
  exitCode.i          ; -1 when unknown
  stdout.s
  stderr.s
  timedOut.i
  cancelled.i
  durationMs.i
EndStructure

; PureBasic children consume grouping quotes and treat backslashes literally.
; Quote whitespace/empty args; ToolRun rejects embedded quotes because this
; parser cannot preserve them. Argument regressions live in test/compiler.mjs.
Procedure.s ProcQ(Arg$)
  If Arg$ = "" : ProcedureReturn Chr(34) + Chr(34) : EndIf
  If FindString(Arg$, " ", 1) Or FindString(Arg$, Chr(9), 1) : ProcedureReturn Chr(34) + Arg$ + Chr(34) : EndIf
  ProcedureReturn Arg$
EndProcedure

CompilerIf #PB_Compiler_OS = #PB_OS_Windows
Import "kernel32.lib"
  JobCreate(*attributes, *name) As "CreateJobObjectW"
  JobOpen(access.l, inherit.l, *name) As "OpenJobObjectW"
  JobAssign(job.i, process.i) As "AssignProcessToJobObject"
  JobSetLimits(job.i, infoClass.l, *info, size.l) As "SetInformationJobObject"
  JobTerminate(job.i, exitCode.l) As "TerminateJobObject"
EndImport
; Native job structures are not supplied by PureBasic's Windows residents.
Structure JobBasicLimitsT Align #PB_Structure_AlignC
  processTime.q
  jobTime.q
  flags.l
  minWorkingSet.i
  maxWorkingSet.i
  activeProcesses.l
  affinity.i
  priority.l
  scheduling.l
EndStructure
Structure JobLimitsT Align #PB_Structure_AlignC
  basic.JobBasicLimitsT
  ioCounters.q[6]
  processMemory.i
  jobMemory.i
  peakProcessMemory.i
  peakJobMemory.i
EndStructure
#PBMCP_JOB_EXTENDED_LIMITS = 9
#PBMCP_JOB_KILL_ON_CLOSE = $2000
#PBMCP_JOB_ASSIGN_PROCESS = 1
#PBMCP_HANDLE_INHERIT = 1

; The worker joins the job before starting user code. The server alone owns
; the job handle, so server exit also terminates every contained process.
Procedure.i RunJobWorker()
  Protected name$ = ProgramParameter(1), eventName$ = name$ + "-started"
  Protected job.i = JobOpen(#PBMCP_JOB_ASSIGN_PROCESS, #False, @name$)
  If job = 0 : ProcedureReturn 1 : EndIf
  If JobAssign(job, GetCurrentProcess_()) = 0
    CloseHandle_(job)
    ProcedureReturn 1
  EndIf
  CloseHandle_(job)
  Protected started.i = OpenEvent_(#EVENT_MODIFY_STATE, #False, @eventName$)
  If started = 0 : ProcedureReturn 1 : EndIf
  Protected errorWriter.i = Val(ProgramParameter(2))
  Protected command$ = ProcQ(ProgramParameter(3)), k.i
  For k = 4 To CountProgramParameters() - 1
    command$ + " " + ProcQ(ProgramParameter(k))
  Next
  Protected startup.STARTUPINFO, child.PROCESS_INFORMATION, exitCode.l = 1
  startup\cb = SizeOf(STARTUPINFO)
  startup\dwFlags = #STARTF_USESTDHANDLES | #STARTF_USESHOWWINDOW
  startup\wShowWindow = #SW_HIDE
  startup\hStdInput = GetStdHandle_(#STD_INPUT_HANDLE)
  startup\hStdOutput = GetStdHandle_(#STD_OUTPUT_HANDLE)
  startup\hStdError = errorWriter
  If CreateProcess_(0, @command$, 0, 0, #True, #CREATE_NO_WINDOW, 0, 0, @startup, @child)
    CloseHandle_(errorWriter)
    SetEvent_(started)
    CloseHandle_(started)
    CloseHandle_(child\hThread)
    WaitForSingleObject_(child\hProcess, #INFINITE)
    GetExitCodeProcess_(child\hProcess, @exitCode)
    CloseHandle_(child\hProcess)
  Else
    CloseHandle_(errorWriter)
    CloseHandle_(started)
  EndIf
  ProcedureReturn exitCode
EndProcedure
CompilerElse
ImportC ""
  ProcessGroupSignal(pid.l, signal.l) As "kill"
  ProcessOwnPid() As "getpid"
  ProcessParentPid() As "getppid"
  ProcessSetSignal(signal.l, *handler) As "signal"
  ProcessParentDeath(option.l, signal.i, arg3.i, arg4.i, arg5.i) As "prctl"
  ProcessPipe(*fds) As "pipe"
  ProcessPipeFlags(fd.l, command.l, value.l) As "fcntl"
  ProcessPipeRead(fd.l, *buffer, bytes.i) As "read"
  ProcessPipeClose(fd.l) As "close"
  ProcessPipeDup(fd.l, target.l) As "dup2"
EndImport
#PBMCP_PR_SET_PDEATHSIG = 1
#PBMCP_F_SETFD = 2
#PBMCP_F_SETFL = 4
#PBMCP_FD_CLOEXEC = 1
#PBMCP_O_NONBLOCK = 2048

; shortcut: detached Linux descendants can escape; add stronger containment if they must be stopped.
Procedure KillTree(Pid.i)
  If ProcessGroupSignal(-Pid, 15) = 0 : Delay(500) : EndIf
  ProcessGroupSignal(-Pid, 9)
EndProcedure

ProcedureC RunParentExited(signal.l)
  ProcessGroupSignal(-ProcessOwnPid(), 9)
EndProcedure

Procedure.i RunJobWorker()
  ProcessSetSignal(15, @RunParentExited())
  If ProcessParentDeath(#PBMCP_PR_SET_PDEATHSIG, 15, 0, 0, 0) <> 0 : ProcedureReturn 1 : EndIf
  ; The server may have exited between spawning this worker and prctl().
  If ProcessParentPid() <> Val(ProgramParameter(1))
    RunParentExited(15)
    ProcedureReturn 1
  EndIf
  Protected errorWriter.i = Val(ProgramParameter(2))
  If ProcessPipeDup(errorWriter, 2) < 0 : ProcedureReturn 1 : EndIf
  If errorWriter <> 2 : ProcessPipeClose(errorWriter) : EndIf
  Protected params$ = "", k.i
  For k = 4 To CountProgramParameters() - 1
    If k > 4 : params$ + " " : EndIf
    params$ + ProcQ(ProgramParameter(k))
  Next
  Protected p.i = RunProgram(ProgramParameter(3), params$, GetCurrentDirectory(), #PB_Program_Open | #PB_Program_Hide)
  If p = 0 : ProcedureReturn 1 : EndIf
  WaitProgram(p)
  Protected exitCode.i = ProgramExitCode(p)
  CloseProgram(p)
  ProcedureReturn exitCode
EndProcedure
CompilerEndIf

Structure ErrorPipeT
  reader.i
  writer.i
EndStructure

Procedure CloseErrorPipe(Handle.i)
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    CloseHandle_(Handle)
  CompilerElse
    ProcessPipeClose(Handle)
  CompilerEndIf
EndProcedure

Procedure.i OpenErrorPipe(*pipe.ErrorPipeT)
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    Protected attributes.SECURITY_ATTRIBUTES
    attributes\nLength = SizeOf(SECURITY_ATTRIBUTES)
    attributes\bInheritHandle = #True
    If CreatePipe_(@*pipe\reader, @*pipe\writer, @attributes, 0) = 0 : ProcedureReturn #False : EndIf
    If SetHandleInformation_(*pipe\reader, #PBMCP_HANDLE_INHERIT, 0) : ProcedureReturn #True : EndIf
  CompilerElse
    Protected Dim fds.l(1)
    If ProcessPipe(@fds(0)) <> 0 : ProcedureReturn #False : EndIf
    *pipe\reader = fds(0) : *pipe\writer = fds(1)
    If ProcessPipeFlags(*pipe\reader, #PBMCP_F_SETFL, #PBMCP_O_NONBLOCK) = 0 And ProcessPipeFlags(*pipe\reader, #PBMCP_F_SETFD, #PBMCP_FD_CLOEXEC) = 0
      ProcedureReturn #True
    EndIf
  CompilerEndIf
  CloseErrorPipe(*pipe\reader)
  CloseErrorPipe(*pipe\writer)
  ProcedureReturn #False
EndProcedure

Procedure.i ReadErrorPipe(Handle.i, *Buffer, Size.i)
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    Protected available.l, bytes.l
    If PeekNamedPipe_(Handle, 0, 0, 0, @available, 0) = 0 Or available <= 0 : ProcedureReturn 0 : EndIf
    If Size > available : Size = available : EndIf
    If ReadFile_(Handle, *Buffer, Size, @bytes, 0) : ProcedureReturn bytes : EndIf
  CompilerElse
    Protected bytes.i = ProcessPipeRead(Handle, *Buffer, Size)
    If bytes > 0 : ProcedureReturn bytes : EndIf
  CompilerEndIf
  ProcedureReturn 0
EndProcedure

Structure CaptureT
  *data
  length.i
  capacity.i
  truncated.i
EndStructure

Procedure CaptureBytes(*capture.CaptureT, *Buffer, Bytes.i)
  If Bytes > #MAX_CAPTURE_CHARS - *capture\length
    Bytes = #MAX_CAPTURE_CHARS - *capture\length
    *capture\truncated = #True
  EndIf
  If Bytes <= 0 : ProcedureReturn : EndIf
  If *capture\length + Bytes > *capture\capacity
    Protected capacity.i = (*capture\length + Bytes) * 2, *grown
    If capacity < 65536 : capacity = 65536 : EndIf
    If capacity > #MAX_CAPTURE_CHARS : capacity = #MAX_CAPTURE_CHARS : EndIf
    If *capture\data
      *grown = ReAllocateMemory(*capture\data, capacity)
    Else
      *grown = AllocateMemory(capacity)
    EndIf
    If *grown = 0
      *capture\truncated = #True
      ProcedureReturn
    EndIf
    *capture\data = *grown
    *capture\capacity = capacity
  EndIf
  CopyMemory(*Buffer, *capture\data + *capture\length, Bytes)
  *capture\length + Bytes
EndProcedure

; runProcess port: spawn without shell, capture stdout/stderr, enforce the
; timeout, kill the contained process group/job. Both streams use bounded byte reads and
; decode UTF-8 once, so long lines cannot delay deadlines or grow without limit.
Procedure RunProcessCapture(Exe$, Params$, WorkingDir$, TimeoutMs.i, *r.RunResT)
  *r\spawnFailed = #False
  *r\exitCodeUnknown = #False
  *r\exitCode = -1
  *r\stdout = ""
  *r\stderr = ""
  *r\timedOut = #False
  *r\cancelled = gRequestCancelled
  If *r\cancelled : ProcedureReturn : EndIf
  Protected t0.i = ElapsedMilliseconds()
  Protected p.i, errorPipe.ErrorPipeT
  Protected *scratch = AllocateMemory(65536)
  If *scratch = 0
    *r\spawnFailed = #True
    ProcedureReturn
  EndIf
  If OpenErrorPipe(@errorPipe) = #False
    FreeMemory(*scratch)
    *r\spawnFailed = #True
    ProcedureReturn
  EndIf
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    ; The worker leads the group and kills its remaining members if the server exits.
    p = RunProgram("setsid", ProcQ(ProgramFilename()) + " --job-worker " + Str(ProcessOwnPid()) + " " + Str(errorPipe\writer) + " " + ProcQ(Exe$) + " " + Params$, WorkingDir$,
                   #PB_Program_Open | #PB_Program_Read | #PB_Program_Write | #PB_Program_Hide)
  CompilerElse
    Protected jobName$ = "Local\pbmcp-" + Str(GetCurrentProcessId_()) + "-" + Str(ElapsedMilliseconds()) + "-" + Str(Random(2147483647))
    Protected eventName$ = jobName$ + "-started"
    Protected job.i = JobCreate(0, @jobName$), started.i
    Protected limits.JobLimitsT
    limits\basic\flags = #PBMCP_JOB_KILL_ON_CLOSE
    If job And GetLastError_() <> #ERROR_ALREADY_EXISTS
      If JobSetLimits(job, #PBMCP_JOB_EXTENDED_LIMITS, @limits, SizeOf(limits))
        started = CreateEvent_(0, #True, #False, @eventName$)
        If started And GetLastError_() <> #ERROR_ALREADY_EXISTS
          p = RunProgram(ProgramFilename(), "--job-worker " + ProcQ(jobName$) + " " + Str(errorPipe\writer) + " " + ProcQ(Exe$) + " " + Params$, WorkingDir$,
                         #PB_Program_Open | #PB_Program_Read | #PB_Program_Write | #PB_Program_Hide)
        EndIf
      EndIf
    EndIf
  CompilerEndIf
  CloseErrorPipe(errorPipe\writer)
  If p = 0
    CloseErrorPipe(errorPipe\reader)
    FreeMemory(*scratch)
    CompilerIf #PB_Compiler_OS = #PB_OS_Windows
      If started : CloseHandle_(started) : EndIf
      If job : CloseHandle_(job) : EndIf
    CompilerEndIf
    *r\spawnFailed = #True
    *r\durationMs = ElapsedMilliseconds() - t0
    ProcedureReturn
  EndIf

  ; Compiler/program children receive EOF instead of the MCP client's stdin.
  WriteProgramData(p, #PB_Program_Eof, 0)

  Protected output.CaptureT, errors.CaptureT
  Protected killIssued.i = #False, n.i, available.i, drains.i, killedAt.i
  Protected lastOutputMs.i = -1000

  While ProgramRunning(p)
    PollControlMessages()
    ; 6.40 ReadProgramData waits for the requested SIZE, contrary to the
    ; reference's "up to size" wording. Read only the available snapshot.
    ; Bound work per poll so continuously flooding output cannot starve timeout.
    drains = 0
    While drains < 64
      available = AvailableProgramOutput(p)
      If available <= 0 : Break : EndIf
      If available > 65536 : available = 65536 : EndIf
      n = ReadProgramData(p, *scratch, available)
      drains + 1
      If n <= 0 : Break : EndIf
      CaptureBytes(@output, *scratch, n)
      lastOutputMs = ElapsedMilliseconds()
    Wend
    For drains = 1 To 64
      n = ReadErrorPipe(errorPipe\reader, *scratch, 65536)
      If n <= 0 : Break : EndIf
      CaptureBytes(@errors, *scratch, n)
      lastOutputMs = ElapsedMilliseconds()
    Next

    If killIssued = #False And (gRequestCancelled Or ElapsedMilliseconds() - t0 >= TimeoutMs)
      *r\cancelled = gRequestCancelled
      *r\timedOut = Bool(Not *r\cancelled)
      killIssued = #True
      killedAt = ElapsedMilliseconds()
      CompilerIf #PB_Compiler_OS = #PB_OS_Windows
        JobTerminate(job, 1)
      CompilerElse
        KillTree(ProgramID(p))
      CompilerEndIf
      KillProgram(p)
    EndIf
    If killIssued And ElapsedMilliseconds() - killedAt > 10000
      *r\exitCodeUnknown = #True   ; unkillable past the panic backstop
      Break
    EndIf
    If killIssued = #False And ElapsedMilliseconds() - lastOutputMs >= #CAPTURE_SPIN_MS
      Delay(15)
    EndIf
  Wend

  ; Reap descendants before draining inherited pipes and removing their exe.
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    *r\spawnFailed = Bool(WaitForSingleObject_(started, 0) <> #WAIT_OBJECT_0)
    CloseHandle_(started)
    CloseHandle_(job)
  CompilerElse
    If Not killIssued : KillTree(ProgramID(p)) : EndIf
  CompilerEndIf

  ; Bound final reads: detached descendants may keep writing after the worker exits.
  Protected remaining.i = #MAX_CAPTURE_CHARS - output\length + 1
  While remaining > 0
    available = AvailableProgramOutput(p)
    If available > 65536 : available = 65536 : EndIf
    If available > remaining : available = remaining : EndIf
    If available <= 0 : Break : EndIf
    n = ReadProgramData(p, *scratch, available)
    If n <= 0 : Break : EndIf
    CaptureBytes(@output, *scratch, n)
    remaining - n
  Wend
  remaining = #MAX_CAPTURE_CHARS - errors\length + 1
  While remaining > 0
    available = remaining
    If available > 65536 : available = 65536 : EndIf
    n = ReadErrorPipe(errorPipe\reader, *scratch, available)
    If n <= 0 : Break : EndIf
    CaptureBytes(@errors, *scratch, n)
    remaining - n
  Wend
  CloseErrorPipe(errorPipe\reader)

  If *r\exitCodeUnknown
    *r\exitCode = -1
  Else
    *r\exitCode = ProgramExitCode(p)
  EndIf
  If output\length > 0
    ; UTF-8 decode is deliberate: correct on CP65001 consoles (and Linux),
    ; may yield U+FFFD elsewhere; #PB_Ascii rejected (breaks CP65001).
    *r\stdout = PeekS(output\data, output\length, #PB_UTF8 | #PB_ByteLength)
  EndIf
  If errors\length > 0 : *r\stderr = ReplaceString(PeekS(errors\data, errors\length, #PB_UTF8 | #PB_ByteLength), Chr(13), "") : EndIf
  If output\truncated : *r\stdout + Chr(10) + "…[stdout truncated at 4 MB]" : EndIf
  If errors\truncated : *r\stderr + Chr(10) + "…[stderr truncated at 4 MB]" : EndIf
  *r\durationMs = ElapsedMilliseconds() - t0
  If output\data : FreeMemory(output\data) : EndIf
  If errors\data : FreeMemory(errors\data) : EndIf
  FreeMemory(*scratch)
  CloseProgram(p)
EndProcedure

; ---------------------------------------------------------------------------
; bounded project-tree staging with owned cleanup
; ---------------------------------------------------------------------------
#PROJECT_MAX_ENTRIES = 10000
#PROJECT_MAX_BYTES = 268435456
#PROJECT_MAX_DEPTH = 64
#PROJECT_STAGE_TIMEOUT_MS = 15000
#PROJECT_COPY_CHUNK = 65536
#PROJECT_FILE_ATTRIBUTE_REPARSE_POINT = $400
#PROJECT_FILE_ATTRIBUTE_DIRECTORY = $10

CompilerIf #PB_Compiler_OS = #PB_OS_Linux
  ; statx is used with AT_SYMLINK_NOFOLLOW so links and special files are
  ; classified without opening/following them. The statx wire layout is fixed.
  #PROJECT_AT_FDCWD = -100
  #PROJECT_AT_SYMLINK_NOFOLLOW = $100
  #PROJECT_STATX_TYPE = 1
  ImportC ""
    ProjectStatx(dirfd.i, *pathname, flags.i, mask.i, *statxbuf) As "statx"
  EndImport
CompilerEndIf

Structure TempCopyT
  dir.s                  ; the freshly-created, exclusively-owned workspace
  root.s                 ; staged project root
  file.s                 ; staged entry source file
  sourceRoot.s
  sourceFile.s
  error.s
  ok.i
EndStructure

Structure ProjectStageT
  error.s
  entries.i
  bytes.q
  started.i
EndStructure

Declare CleanupTempDir(Dir$)
Declare.i ProjectVisitDirectory(Source$, Destination$, Depth.i, *stage.ProjectStageT, CopyTree.i)

Procedure.s ProjectNormalizedPath(Path$)
  Protected normalized$ = ResolvePath(Path$)
  While Len(normalized$) > 1 And Right(normalized$, 1) = #PathSep$
    CompilerIf #PB_Compiler_OS = #PB_OS_Windows
      If Len(normalized$) = 3 And Mid(normalized$, 2, 1) = ":" : Break : EndIf
    CompilerEndIf
    normalized$ = Left(normalized$, Len(normalized$) - 1)
  Wend
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    normalized$ = LCase(normalized$)
  CompilerEndIf
  ProcedureReturn normalized$
EndProcedure

Procedure.i ProjectPathWithin(Path$, Root$)
  Protected pathNorm$ = ProjectNormalizedPath(Path$)
  Protected rootNorm$ = ProjectNormalizedPath(Root$)
  If pathNorm$ = rootNorm$ : ProcedureReturn #True : EndIf
  If Right(rootNorm$, 1) <> #PathSep$ : rootNorm$ + #PathSep$ : EndIf
  ProcedureReturn Bool(Left(pathNorm$, Len(rootNorm$)) = rootNorm$)
EndProcedure

Procedure.i ProjectIsFilesystemRoot(Path$)
  Protected normalized$ = ProjectNormalizedPath(Path$)
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    ProcedureReturn Bool(normalized$ = "/")
  CompilerElse
    If Len(normalized$) = 3 And Mid(normalized$, 2, 1) = ":" And Right(normalized$, 1) = "\"
      ProcedureReturn #True
    EndIf
    ; A UNC share root has only the server and share components.
    If Left(normalized$, 2) = "\\" And CountString(normalized$, "\") = 3
      ProcedureReturn #True
    EndIf
  CompilerEndIf
  ProcedureReturn #False
EndProcedure

; Returns: -1 unavailable, 0 regular file, 1 directory, 2 unsupported special,
; 3 symbolic link or Windows reparse point.
Procedure.i ProjectNativeType(Path$, *stage.ProjectStageT)
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    Protected attributes.i = GetFileAttributes_(@Path$)
    If attributes = -1 Or (attributes & $FFFFFFFF) = $FFFFFFFF
      *stage\error = "cannot read native filesystem metadata for " + Path$
      ProcedureReturn -1
    EndIf
    If attributes & #PROJECT_FILE_ATTRIBUTE_REPARSE_POINT
      ProcedureReturn 3
    EndIf
    If attributes & #PROJECT_FILE_ATTRIBUTE_DIRECTORY
      ProcedureReturn 1
    EndIf
    ProcedureReturn 0
  CompilerElse
    Protected pathBytes.i = StringByteLength(Path$, #PB_UTF8) + 1
    Protected *nativePath = AllocateMemory(pathBytes)
    Protected *metadata = AllocateMemory(256)
    If *nativePath = 0 Or *metadata = 0
      If *nativePath : FreeMemory(*nativePath) : EndIf
      If *metadata : FreeMemory(*metadata) : EndIf
      *stage\error = "out of memory checking filesystem entry " + Path$
      ProcedureReturn -1
    EndIf
    PokeS(*nativePath, Path$, -1, #PB_UTF8)
    If ProjectStatx(#PROJECT_AT_FDCWD, *nativePath, #PROJECT_AT_SYMLINK_NOFOLLOW, #PROJECT_STATX_TYPE, *metadata) <> 0
      FreeMemory(*nativePath)
      FreeMemory(*metadata)
      *stage\error = "cannot read no-follow filesystem metadata for " + Path$
      ProcedureReturn -1
    EndIf
    Protected mode.i = PeekL(*metadata + 28) & $FFFF
    FreeMemory(*nativePath)
    FreeMemory(*metadata)
    Select mode & $F000
      Case $8000 : ProcedureReturn 0 ; regular file
      Case $4000 : ProcedureReturn 1 ; directory
      Case $A000 : ProcedureReturn 3 ; symbolic link
      Default    : ProcedureReturn 2 ; FIFO/socket/device/other special entry
    EndSelect
  CompilerEndIf
EndProcedure

; Walk every existing component using no-follow metadata. The final component
; may be a regular entry; every parent must be a directory.
Procedure.i ProjectCheckPathComponents(InputPath$, *stage.ProjectStageT)
  Protected path$ = ResolvePath(InputPath$)
  Protected current$ = "", start.i = 1, i.i, component$, kind.i
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    current$ = "/" : start = 2
  CompilerElse
    path$ = ReplaceString(path$, "/", "\")
    If Len(path$) >= 3 And Mid(path$, 2, 1) = ":"
      current$ = Left(path$, 3) : start = 4
    ElseIf Left(path$, 2) = "\\"
      Protected serverEnd.i = FindString(path$, "\", 3)
      Protected shareEnd.i
      If serverEnd = 0
        *stage\error = "unsupported or incomplete UNC path: " + path$
        ProcedureReturn #False
      EndIf
      shareEnd = FindString(path$, "\", serverEnd + 1)
      If shareEnd = 0
        current$ = path$ : start = Len(path$) + 1
      Else
        current$ = Left(path$, shareEnd - 1) : start = shareEnd + 1
      EndIf
    Else
      *stage\error = "path is not an absolute local or UNC path: " + path$
      ProcedureReturn #False
    EndIf
  CompilerEndIf

  If Len(current$) > 0 And Len(current$) < Len(path$)
    kind = ProjectNativeType(current$, *stage)
    If kind < 0 : ProcedureReturn #False : EndIf
    If kind = 3
      *stage\error = "symbolic links/reparse points are not allowed in project paths: " + current$
      ProcedureReturn #False
    ElseIf kind <> 1
      *stage\error = "a project path component is not a directory: " + current$
      ProcedureReturn #False
    EndIf
  EndIf

  For i = start To Len(path$) + 1
    If i > Len(path$) Or Mid(path$, i, 1) = #PathSep$
      component$ = Mid(path$, start, i - start)
      If component$ <> ""
        current$ = PathJoin(current$, component$)
        kind = ProjectNativeType(current$, *stage)
        If kind < 0 : ProcedureReturn #False : EndIf
        If kind = 3
          *stage\error = "symbolic links/reparse points are not allowed in project paths: " + current$
          ProcedureReturn #False
        ElseIf i <= Len(path$) And kind <> 1
          *stage\error = "a parent path component is not a directory: " + current$
          ProcedureReturn #False
        EndIf
      EndIf
      start = i + 1
    EndIf
  Next
  ProcedureReturn #True
EndProcedure

Procedure.i ProjectTimeAvailable(*stage.ProjectStageT, Path$)
  If ElapsedMilliseconds() - *stage\started > #PROJECT_STAGE_TIMEOUT_MS
    *stage\error = "staging exceeded the 15-second time limit at " + Path$ + "; reduce the selected projectRoot"
    ProcedureReturn #False
  EndIf
  ProcedureReturn #True
EndProcedure

Procedure.i ProjectCopyRegularFile(Source$, Destination$, ExpectedSize.q, *stage.ProjectStageT)
  Protected kind.i = ProjectNativeType(Source$, *stage)
  If kind <> 0
    If *stage\error = "" : *stage\error = "entry changed or is not a regular file: " + Source$ : EndIf
    ProcedureReturn #False
  EndIf
  Protected input.i = ReadFile(#PB_Any, Source$)
  If input = 0
    *stage\error = "cannot open project file for reading: " + Source$
    ProcedureReturn #False
  EndIf
  Protected output.i = CreateFile(#PB_Any, Destination$)
  If output = 0
    CloseFile(input)
    *stage\error = "cannot create staged file: " + Destination$
    ProcedureReturn #False
  EndIf
  Protected *buffer = AllocateMemory(#PROJECT_COPY_CHUNK)
  If *buffer = 0
    CloseFile(input) : CloseFile(output)
    *stage\error = "out of memory copying project file: " + Source$
    ProcedureReturn #False
  EndIf
  Protected copied.q = 0, amount.i
  While Not Eof(input)
    If Not ProjectTimeAvailable(*stage, Source$) : Break : EndIf
    amount = ReadData(input, *buffer, #PROJECT_COPY_CHUNK)
    If amount <= 0
      *stage\error = "read failed while copying project file: " + Source$
      Break
    EndIf
    If WriteData(output, *buffer, amount) <> amount
      *stage\error = "write failed while staging project file: " + Destination$
      Break
    EndIf
    copied + amount
    *stage\bytes + amount
    If *stage\bytes > #PROJECT_MAX_BYTES
      *stage\error = "project exceeds the 256 MiB regular-file limit while copying " + Source$
      Break
    EndIf
  Wend
  FreeMemory(*buffer)
  CloseFile(input) : CloseFile(output)
  If *stage\error = "" And (copied <> ExpectedSize Or FileSize(Source$) <> ExpectedSize)
    *stage\error = "source file changed while staging: " + Source$
  EndIf
  If *stage\error <> "" : ProcedureReturn #False : EndIf
  ProcedureReturn #True
EndProcedure

; CopyTree=#False performs the complete preflight. The same bounds and
; metadata checks run again during the copy pass to detect changes.
Procedure.i ProjectVisitDirectory(Source$, Destination$, Depth.i, *stage.ProjectStageT, CopyTree.i)
  If Depth > #PROJECT_MAX_DEPTH
    *stage\error = "project nesting exceeds the 64-directory depth limit at " + Source$
    ProcedureReturn #False
  EndIf
  If Not ProjectTimeAvailable(*stage, Source$) : ProcedureReturn #False : EndIf
  If CopyTree And Not CreateDirectory(Destination$)
    *stage\error = "cannot create staged directory: " + Destination$
    ProcedureReturn #False
  EndIf
  Protected directory.i = ExamineDirectory(#PB_Any, Source$, "")
  If directory = 0
    *stage\error = "cannot enumerate project directory: " + Source$
    ProcedureReturn #False
  EndIf
  Protected name$, sourceEntry$, destinationEntry$, kind.i, size.q
  While NextDirectoryEntry(directory)
    name$ = DirectoryEntryName(directory)
    If name$ = "." Or name$ = ".." : Continue : EndIf
    If Not ProjectTimeAvailable(*stage, Source$) : Break : EndIf
    *stage\entries + 1
    If *stage\entries > #PROJECT_MAX_ENTRIES
      *stage\error = "project exceeds the 10,000 visited-entry limit at " + Source$ + "; narrow projectRoot"
      Break
    EndIf
    sourceEntry$ = PathJoin(Source$, name$)
    If CopyTree : destinationEntry$ = PathJoin(Destination$, name$) : EndIf
    kind = ProjectNativeType(sourceEntry$, *stage)
    If kind < 0 : Break : EndIf
    If kind = 3
      *stage\error = "symbolic link/reparse point is not allowed in a project tree: " + sourceEntry$
      Break
    ElseIf kind = 2
      *stage\error = "unsupported special filesystem entry in project tree: " + sourceEntry$
      Break
    EndIf
    If kind = 1
      If LCase(name$) = ".git" Or LCase(name$) = ".hg" Or LCase(name$) = ".svn"
        Continue
      EndIf
      If CopyTree And Not ProjectTimeAvailable(*stage, sourceEntry$) : Break : EndIf
      If Not ProjectVisitDirectory(sourceEntry$, destinationEntry$, Depth + 1, *stage, CopyTree)
        Break
      EndIf
    Else
      size = FileSize(sourceEntry$)
      If size < 0
        *stage\error = "cannot determine regular-file size: " + sourceEntry$
        Break
      EndIf
      If *stage\bytes > #PROJECT_MAX_BYTES - size
        *stage\error = "project exceeds the 256 MiB regular-file limit at " + sourceEntry$ + "; narrow projectRoot"
        Break
      EndIf
      If CopyTree
        If Not ProjectCopyRegularFile(sourceEntry$, destinationEntry$, size, *stage) : Break : EndIf
      Else
        *stage\bytes + size
      EndIf
    EndIf
  Wend
  FinishDirectory(directory)
  ProcedureReturn Bool(*stage\error = "")
EndProcedure

; Resolve/validate the selected entry and stage the complete tree beneath a
; newly-owned pbmcp-* workspace. *t\dir is recorded immediately on creation.
Procedure MakeTempCopy(SourceFile$, ProjectRoot$, *t.TempCopyT)
  *t\ok = #False
  *t\dir = "" : *t\root = "" : *t\file = "" : *t\error = ""
  *t\sourceFile = ResolvePath(SourceFile$)
  If ProjectRoot$ = ""
    *t\sourceRoot = GetPathPart(*t\sourceFile)
  Else
    *t\sourceRoot = ResolvePath(ProjectRoot$)
  EndIf
  *t\sourceRoot = ProjectNormalizedPath(*t\sourceRoot)
  *t\sourceFile = ProjectNormalizedPath(*t\sourceFile)

  Protected stage.ProjectStageT
  If ProjectIsFilesystemRoot(*t\sourceRoot)
    *t\error = "projectRoot must not be a filesystem root: " + *t\sourceRoot
    ProcedureReturn
  EndIf
  If FileSize(*t\sourceRoot) <> -2
    *t\error = "projectRoot is missing or is not a directory: " + *t\sourceRoot
    ProcedureReturn
  EndIf
  If Not ProjectPathWithin(*t\sourceFile, *t\sourceRoot) Or *t\sourceFile = *t\sourceRoot
    *t\error = "entry file is outside projectRoot: " + *t\sourceFile + "; choose an encompassing projectRoot"
    ProcedureReturn
  EndIf
  If Not ProjectCheckPathComponents(*t\sourceRoot, @stage) Or Not ProjectCheckPathComponents(*t\sourceFile, @stage)
    *t\error = "project staging failed: " + stage\error
    ProcedureReturn
  EndIf
  Protected sourceType.i = ProjectNativeType(*t\sourceFile, @stage)
  If sourceType <> 0
    If stage\error <> "" : *t\error = "project staging failed: " + stage\error
    Else : *t\error = "entry must be a regular file: " + *t\sourceFile
    EndIf
    ProcedureReturn
  EndIf

  Protected base$ = GetTemporaryDirectory()
  CompilerIf #PB_Compiler_OS = #PB_OS_Linux
    ; Keep ProcQ arguments whitespace-free when TMPDIR contains spaces.
    If (FindString(base$, " ", 1) Or FindString(base$, Chr(9), 1)) And FileSize("/tmp") = -2
      base$ = "/tmp"
    EndIf
  CompilerEndIf
  base$ = ProjectNormalizedPath(base$)
  If ProjectPathWithin(base$, *t\sourceRoot)
    *t\error = "temporary staging destination would be inside projectRoot: " + base$ + "; choose a narrower projectRoot"
    ProcedureReturn
  EndIf

  stage\started = ElapsedMilliseconds()
  If Not ProjectTimeAvailable(@stage, *t\sourceRoot)
    *t\error = "project staging failed: " + stage\error
    ProcedureReturn
  EndIf
  stage\entries = 0 : stage\bytes = 0
  If Not ProjectVisitDirectory(*t\sourceRoot, "", 0, @stage, #False)
    *t\error = "project staging failed: " + stage\error + "; check projectRoot, links, permissions, and the staging limits"
    ProcedureReturn
  EndIf
  Protected expectedEntries.i = stage\entries
  Protected expectedBytes.q = stage\bytes

  If Right(base$, 1) <> #PathSep$ : base$ + #PathSep$ : EndIf
  Protected tries.i
  For tries = 1 To 20
    Protected dir$ = base$ + "pbmcp-" + Str(ElapsedMilliseconds()) + "-" + Str(Random(999999))
    If CreateDirectory(dir$)
      *t\dir = dir$ ; own it before any further operation can fail
      *t\root = PathJoin(dir$, "project")
      Break
    EndIf
    Delay(2)
  Next
  If *t\dir = ""
    *t\error = "project staging failed: cannot create an owned temporary workspace under " + base$
    ProcedureReturn
  EndIf

  stage\entries = 0 : stage\bytes = 0
  If Not ProjectVisitDirectory(*t\sourceRoot, *t\root, 0, @stage, #True)
    *t\error = "project staging failed: " + stage\error + "; partial staged files were discarded"
    CleanupTempDir(*t\dir)
    *t\dir = "" : *t\root = ""
    ProcedureReturn
  EndIf
  If stage\entries <> expectedEntries Or stage\bytes <> expectedBytes
    *t\error = "project staging failed: source tree changed between validation and copy at " + *t\sourceRoot
    CleanupTempDir(*t\dir)
    *t\dir = "" : *t\root = ""
    ProcedureReturn
  EndIf

  Protected relativeFile$ = Mid(*t\sourceFile, Len(*t\sourceRoot) + 1)
  If Left(relativeFile$, 1) = #PathSep$ : relativeFile$ = Mid(relativeFile$, 2) : EndIf
  *t\file = PathJoin(*t\root, relativeFile$)
  If FileSize(*t\file) < 0
    *t\error = "project staging failed: staged entry is missing: " + *t\file
    CleanupTempDir(*t\dir)
    *t\dir = "" : *t\root = "" : *t\file = ""
    ProcedureReturn
  EndIf
  *t\ok = #True
EndProcedure

; cleanupTemp: best-effort recursive delete; AV scanners hold fresh exes for
; a few hundred ms, hence the bounded backoff. Only callers holding the
; recorded owned workspace path may invoke this.
Procedure CleanupTempDir(Dir$)
  If Dir$ = "" : ProcedureReturn : EndIf
  Protected delay.i, attempt.i
  For attempt = 0 To 3   ; [0, 100, 250, 500] bounded AV-lock retry
    If attempt = 0 : delay = 0
    ElseIf attempt = 1 : delay = 100
    ElseIf attempt = 2 : delay = 250
    Else : delay = 500
    EndIf
    If delay > 0 : Delay(delay) : EndIf
    If DeleteDirectory(Dir$, "", #PB_FileSystem_Recursive | #PB_FileSystem_Force)
      ProcedureReturn
    EndIf
  Next
EndProcedure

; ---------------------------------------------------------------------------
; source reading (line count + hint lint)
; ---------------------------------------------------------------------------

; Count CR/LF/CRLF lines in chunks; retain UTF-8 text only within the lint limit.
; The extra chunk detects overflow without allocating from the file's size.
Procedure.i ReadCheckSource(File$, *Source.String)
  *Source\s = ""
  Protected f.i = ReadFile(#PB_Any, File$)
  If f = 0 : ProcedureReturn -1 : EndIf
  Protected *buffer = AllocateMemory(#MAX_LINT_SOURCE_BYTES + 65536)
  If *buffer = 0 : CloseFile(f) : ProcedureReturn -1 : EndIf
  Protected expected.i = Lof(f), total.i, kept.i, bytes.i, i.i, c.a, last.a, lines.i
  Repeat
    bytes = ReadData(f, *buffer + kept, 65536)
    For i = 0 To bytes - 1
      c = PeekA(*buffer + kept + i)
      If c = 13 Or (c = 10 And last <> 13) : lines + 1 : EndIf
      last = c
    Next
    total + bytes
    If total <= #MAX_LINT_SOURCE_BYTES : kept = total : Else : kept = 0 : EndIf
  Until bytes = 0
  CloseFile(f)
  If total <> expected
    FreeMemory(*buffer)
    ProcedureReturn -1
  EndIf
  If total > 0
    If last <> 10 And last <> 13 : lines + 1 : EndIf
    If total <= #MAX_LINT_SOURCE_BYTES
      *Source\s = PeekS(*buffer, total, #PB_UTF8 | #PB_ByteLength)
    EndIf
  EndIf
  FreeMemory(*buffer)
  ProcedureReturn lines
EndProcedure

; sourceLineAtNorm: 1-based line over an ALREADY CRLF-normalized text (lone
; \r stays in-line, as before) - StringField only. The caller normalizes
; once; the old SourceLineAt re-normalized the whole file per call.
Procedure.s SourceLineAtNorm(Text$, Line.i)
  If Line < 1 : ProcedureReturn "" : EndIf
  ProcedureReturn StringField(Text$, Line, Chr(10))
EndProcedure

; ---------------------------------------------------------------------------
; compile step with transient-failure retry
; ---------------------------------------------------------------------------

; Retry only the observed assembler write failure; other errors need a fix.
Procedure.i IsTransientCompileFailure(Output$)
  NewList errs.DiagT()
  NewList warns.DiagT()
  ParseDiagnostics(Output$, errs(), warns())
  If ListSize(errs()) = 0 : ProcedureReturn #False : EndIf
  ForEach errs()
    If errs()\line <> 0 Or LCase(errs()\message) <> "assembler" : ProcedureReturn #False : EndIf
  Next
  ProcedureReturn Bool(FindString(LCase(Output$), "error: write failed"))
EndProcedure

; CompilerStepWithRetry: cwd pinned to the temp dir; the output switch gets
; the absolute output path (suppresses 5.73 auto-launch; correct on 6.40).
; One retry for the known assembler write failure. Switch spellings are per-OS
; constants (#SW_* in config.pb): Windows "/CHECK" "/CONSOLE" "/EXE",
; Linux "--check" "--console" "--output" - "/"-switches do not exist there.
Procedure CompilerStepWithRetry(CompilerExe$, Flag$, SrcFile$, ExeOut$, WorkingDir$, *r.RunResT)
  Protected timeoutMs.i = #CHECK_TIMEOUT_MS
  If Flag$ = #SW_CONSOLE$ : timeoutMs = #COMPILE_TIMEOUT_MS : EndIf
  Protected params$ = Flag$
  If ExeOut$ <> "" : params$ + " " + #SW_EXE$ + " " + ProcQ(ExeOut$) : EndIf
  params$ + " " + ProcQ(SrcFile$)
  RunProcessCapture(CompilerExe$, params$, WorkingDir$, timeoutMs, *r)
  If Not gRequestCancelled And *r\exitCode <> 0 And *r\exitCode <> -1 And *r\timedOut = #False And IsTransientCompileFailure(*r\stdout)
    Delay(250)
    RunProcessCapture(CompilerExe$, params$, WorkingDir$, timeoutMs, *r)
  EndIf
EndProcedure

; ---------------------------------------------------------------------------
; high-confidence error hints (pb_check only)
; ---------------------------------------------------------------------------
Global gHintUndeclared.i = 0
Global gHintConstType.i = 0
Global gHintProcScope.i = 0
Global gHintDimAs.i = 0
Global gHintBadComment.i = 0
Global gHintVbSub.i = 0
Global gLintProcDollar.i = 0
Global gHintsReady.i = #False

Procedure HintsInit()
  gHintUndeclared = CreateRegularExpression(#PB_Any, "\bvariables? have to be declared:\s*(.+)$", #PB_RegularExpression_NoCase)
  gHintConstType  = CreateRegularExpression(#PB_Any, "\bcan'?t have a type\b", #PB_RegularExpression_NoCase)
  ; The same scope diagnostic is used by the supported compiler versions.
  gHintProcScope  = CreateRegularExpression(#PB_Any, "'(?:protected|static)' can only be used inside a procedure", #PB_RegularExpression_NoCase)
  gHintDimAs      = CreateRegularExpression(#PB_Any, "\bDim\s+\w+\s+As\s+", #PB_RegularExpression_NoCase)
  gHintBadComment = CreateRegularExpression(#PB_Any, "^\s*(?:'|//)", #PB_RegularExpression_NoCase)
  gHintVbSub      = CreateRegularExpression(#PB_Any, "\bSub\s+\w|\bEnd\s+Sub\b", #PB_RegularExpression_NoCase)
  ; '$' in a procedure NAME compiles to a bare "Syntax error." (probe-sealed
  ; 5.73 + 6.40) - the hint therefore pairs this source-line lint (matches the
  ; Procedure line's name position, never parameter names like Foo(a$)) with
  ; the generic message at the reported position
  gLintProcDollar = CreateRegularExpression(#PB_Any, "^\s*Procedure\$|^\s*Procedure(\.[A-Za-z*]+)?\s+\w+\$", #PB_RegularExpression_NoCase)
  gHintsReady = #True
EndProcedure

; buildHints: priority order undeclared -> const-type -> source lints (dim-as,
; bad-comment, vb-sub) -> unknown-command bucket; deduplicated by pattern,
; capped at 2.
Procedure BuildHints(List Errors.DiagT(), List Buckets$(), SourceText$, List Hints$())
  ClearList(Hints$())
  If ListSize(Errors()) = 0 : ProcedureReturn : EndIf
  If Not gHintsReady : HintsInit() : EndIf

  ; 1. EnableExplicit wording -> inline fix with the actual missing name
  ForEach Errors()
    If ReMatch(gHintUndeclared, Errors()\message)
      Protected cap$ = gReG1
      Protected name$ = StringField(Trim(ReplaceString(cap$, ",", " ")), 1, " ")
      If name$ <> ""
        AddElement(Hints$())
        Hints$() = "Hint: EnableExplicit is on — declare it first, e.g. `Define " + name$ + ".i` (or `.s` for a string)."
        Break
      EndIf
    EndIf
  Next

  ; 1b. typed-constant wording: "#PlayerSpeed.f = 2.5" is illegal
  ForEach Errors()
    If MatchRegularExpression(gHintConstType, Errors()\message)
      AddElement(Hints$())
      Hints$() = "Hint: constants take no type suffix (`#Name.f` fails) — use `#Name = 1.5` or a variable `Define speed.f`."
      Break
    EndIf
  Next

  ; 1c. Protected/Static at file scope (message-based, probe-sealed 5.73 + 6.40)
  ForEach Errors()
    If MatchRegularExpression(gHintProcScope, Errors()\message)
      AddElement(Hints$())
      Hints$() = "Hint: `Protected`/`Static` can only be used inside a procedure — use `Define` at file scope, `Global` for shared state."
      Break
    EndIf
  Next

  ; 2-4. source-line lint at the reported error positions
  If SourceText$ <> ""
    ; normalize CRLF once for the whole loop (lone CR stays in-line, as before)
    Protected normText$ = ReplaceString(SourceText$, Chr(13) + Chr(10), Chr(10))
    Protected dimAs.i = #False, badComment.i = #False, vbSub.i = #False, procDollar.i = #False
    ForEach Errors()
      If Errors()\file <> "" : Continue : EndIf
      Protected src$ = SourceLineAtNorm(normText$, Errors()\line)
      If src$ = "" : Continue : EndIf
      If Not dimAs And MatchRegularExpression(gHintDimAs, src$) : dimAs = #True : EndIf
      If Not badComment And MatchRegularExpression(gHintBadComment, src$) : badComment = #True : EndIf
      If Not vbSub And MatchRegularExpression(gHintVbSub, src$) : vbSub = #True : EndIf
      If Not procDollar And MatchRegularExpression(gLintProcDollar, src$) : procDollar = #True : EndIf
      If dimAs And badComment And vbSub And procDollar : Break : EndIf
    Next
    If procDollar
      AddElement(Hints$())
      Hints$() = "Hint: a procedure name can't end in `$` — that's the string-variable marker; declare the return type instead: `Procedure.s Name()`."
    EndIf
    If dimAs
      AddElement(Hints$())
      Hints$() = "Hint: PureBasic has no `Dim x As Integer` — use `Define x.i` for variables and `Dim a(n)` for arrays."
    EndIf
    If badComment
      AddElement(Hints$())
      Hints$() = "Hint: comments start with `;` — `'` and `//` are syntax errors in PureBasic."
    EndIf
    If vbSub
      AddElement(Hints$())
      Hints$() = "Hint: use `Procedure Name(...)` … `EndProcedure` (no Sub/End Sub); return values via `ProcedureReturn`."
    EndIf
  EndIf

  ; 5. bucket-level advice for invented command names
  ForEach Buckets$()
    If Buckets$() = "unknown-command"
      AddElement(Hints$())
      Hints$() = "Hint: that command does not exist in PureBasic — run pb_docs_search for the real name (PB names differ from VB/FreeBASIC)."
      Break
    EndIf
  Next

  ; cap 2
  While ListSize(Hints$()) > 2
    LastElement(Hints$())
    DeleteElement(Hints$())
  Wend
EndProcedure

; ---------------------------------------------------------------------------
; best-practice scan (always-on lint; fires on OK and error results alike)
; ---------------------------------------------------------------------------
; Rules cover things the compiler silently
; ACCEPTS - Global inside a procedure, Goto/Gosub, a file without
; EnableExplicit. Rules the compiler already rejects (Protected/Static at
; file scope, '$' procedure names) are HINTS in BuildHints above, not here.

; Strip normal and escaped string literals, then cut at the ; comment start.
; Per-line by design: PB has no multiline strings, so a stray quote can only
; degrade that one line, never leak across lines.
Procedure.s BpStripLine(Line$)
  Protected i.i = 1, n.i = Len(Line$), c.i, written.i = 0, escaped.i
  Protected out$ = Space(n)
  While i <= n
    c = PeekU(@Line$ + (i - 1) * SizeOf(Character))
    If c = 34
      escaped = #False
      If i > 1 : escaped = Bool(PeekU(@Line$ + (i - 2) * SizeOf(Character)) = 126) : EndIf
      i + 1
      While i <= n
        c = PeekU(@Line$ + (i - 1) * SizeOf(Character))
        If escaped And c = 92
          i + 2
        ElseIf c = 34
          If i < n And PeekU(@Line$ + i * SizeOf(Character)) = 34
            i + 2
          Else
            i + 1
            Break
          EndIf
        Else
          i + 1
        EndIf
      Wend
      written + 1                            ; prefilled space keeps token separation
    ElseIf c = 59
      Break
    Else
      PokeU(@out$ + written * SizeOf(Character), c)
      written + 1
      i + 1
    EndIf
  Wend
  ProcedureReturn Left(out$, written)
EndProcedure

; First keyword of a stripped line, lowercased (keywords are case-insensitive;
; first-word matching keeps ProcedureReturn from entering procedure depth).
Procedure.s BpFirstWord(Strip$)
  Protected t$ = LCase(TrimAll(Strip$))
  Protected i.i, n.i = Len(t$), c$
  For i = 1 To n
    c$ = PeekS(@t$ + (i - 1) * SizeOf(Character), 1, #PB_Unicode)
    If (c$ < "a" Or c$ > "z") And (c$ < "0" Or c$ > "9") And c$ <> "_"
      Break
    EndIf
  Next
  ProcedureReturn Left(t$, i - 1)
EndProcedure

; BpScan: collect the notes. Line-anchored notes first (source order), the
; file-level EnableExplicit note last. Max 3 by rule count - no extra cap.
Procedure BpScan(SourceText$, List Notes$())
  ClearList(Notes$())
  If SourceText$ = "" : ProcedureReturn : EndIf
  Protected norm$ = ReplaceString(SourceText$, Chr(13) + Chr(10), Chr(10))
  norm$ = ReplaceString(norm$, Chr(13), Chr(10))
  Protected length.i = Len(norm$)
  Protected explicitSeen.i = #False, inProc.i = #False
  Protected globalLine.i = 0, gotoLine.i = 0
  Protected i.i = 0, start.i = 0, nextLine.i = 0, s$, w$
  Repeat
    While nextLine < length And PeekU(@norm$ + nextLine * SizeOf(Character)) <> 10
      nextLine + 1
    Wend
    i + 1
    s$ = BpStripLine(PeekS(@norm$ + start * SizeOf(Character), nextLine - start, #PB_Unicode))
    w$ = BpFirstWord(s$)
    If w$ = "global" And inProc And globalLine = 0 : globalLine = i : EndIf
    If (w$ = "goto" Or w$ = "gosub") And gotoLine = 0 : gotoLine = i : EndIf
    If w$ = "enableexplicit" : explicitSeen = #True : EndIf
    ; depth: any stripped line containing endprocedure exits (nets zero for
    ; one-line `Procedure X() : EndProcedure`); first word "procedure" enters.
    ; Mid-line `: EndProcedure` and a macro-local `Procedure` without an
    ; EndProcedure in the same macro are the known tradeoffs - best-effort lint.
    If FindString(LCase(s$), "endprocedure", 1) > 0
      inProc = #False
    ElseIf w$ = "procedure"
      inProc = #True
    EndIf
    start = nextLine + 1
    nextLine = start
  Until start >= length
  If globalLine > 0
    AddElement(Notes$())
    Notes$() = "Line " + Str(globalLine) + ": `Global` inside a procedure creates hidden shared state — declare globals at file scope."
  EndIf
  If gotoLine > 0
    AddElement(Notes$())
    Notes$() = "Line " + Str(gotoLine) + ": avoid `Goto`/`Gosub` — use procedures and structured control flow."
  EndIf
  If explicitSeen = #False
    AddElement(Notes$())
    Notes$() = "Add `EnableExplicit` at the top — without it every typo compiles as an undeclared integer."
  EndIf
EndProcedure

; ---------------------------------------------------------------------------
; pb_check result
; ---------------------------------------------------------------------------

; Keep source diagnostics compact; include raw details for line-less failures.
Procedure.s FormatCheckResult(StartMs.i, LineCount.i, Ok.i, TimedOut.i, List Errors.DiagT(), List Warnings.DiagT(), RawTail$, File$, SourceText$, List Buckets$())
  Protected out$ = ""
  If Not Ok
    If TimedOut
      out$ = "COMPILER TIMEOUT after " + Str(#CHECK_TIMEOUT_MS) + " ms (" + File$ + ")"
    Else
      out$ = "ERRORS (" + Str(ListSize(Errors())) + "):"
    EndIf
    If TimedOut = #False
      If ListSize(Errors()) > 0
        ; hints between the header and the error lines (fixed order);
        ; Buckets$() comes pre-classified from the caller - one
        ; MetricsClassifyBuckets run per pb_check, output unchanged
        NewList hints$()
        BuildHints(Errors(), Buckets$(), SourceText$, hints$())
        ForEach hints$()
          out$ + Chr(10) + hints$()
        Next
      EndIf
      Protected shown.i = 0
      ForEach Errors()
        If shown >= 40 : Break : EndIf
        out$ + Chr(10) + "Line " + Str(Errors()\line) + ": " + Errors()\message
        If Errors()\file <> "" : out$ + " (in " + Errors()\file + ")" : EndIf
        shown + 1
      Next
      If ListSize(Errors()) > shown
        out$ + Chr(10) + "… +" + Str(ListSize(Errors()) - shown) + " more errors"
      EndIf
      If RawTail$ <> ""
        out$ + Chr(10) + "Raw compiler output (last lines):"
        out$ + Chr(10) + RawTail$
      EndIf
    EndIf
  EndIf

  out$ + FormatWarnings(Warnings())

  ; best-practice notes: last section (least severe); silence on clean files
  ; keeps every pinned OK/ERROR shape byte-identical
  If SourceText$ <> "" And LineCount > 0
    NewList bp$()
    BpScan(SourceText$, bp$())
    If ListSize(bp$()) > 0
      out$ + Chr(10) + "Best practices (" + Str(ListSize(bp$())) + "):"
      ForEach bp$()
        out$ + Chr(10) + bp$()
      Next
    EndIf
  EndIf
  If Ok
    out$ = "OK — " + Str(LineCount) + " lines, " + Str(ElapsedMilliseconds() - StartMs) + " ms (" + File$ + ")" + out$
  EndIf
  ProcedureReturn CapText(out$, #CHECK_CAP)
EndProcedure

; ---------------------------------------------------------------------------
; pb_check handler
; ---------------------------------------------------------------------------
Structure CheckResT
  ok.i
  lineCount.i
  timedOut.i
  rawTail.s
  sourceText.s
  stagingError.s
  List errors.DiagT()
  List warnings.DiagT()
EndStructure

; runCheck: temp-copy + /CHECK + parse + rawTail extraction.
Procedure RunCheck(CompilerExe$, AbsFile$, ProjectRoot$, *c.CheckResT)
  ClearList(*c\errors())
  ClearList(*c\warnings())
  *c\ok = #False
  *c\lineCount = 0
  *c\timedOut = #False
  *c\rawTail = ""
  *c\sourceText = ""
  *c\stagingError = ""

  Protected source.String
  *c\lineCount = ReadCheckSource(AbsFile$, @source)
  If *c\lineCount < 0
    *c\rawTail = "cannot read source file: " + AbsFile$
    ProcedureReturn
  EndIf
  *c\sourceText = source\s

  Protected copy.TempCopyT
  MakeTempCopy(AbsFile$, ProjectRoot$, @copy)
  If copy\ok = #False
    *c\stagingError = copy\error
    ProcedureReturn
  EndIf

  Protected proc.RunResT
  CompilerStepWithRetry(CompilerExe$, #SW_CHECK$, copy\file, PathJoin(copy\dir, "check" + #ExeSuffix$), GetPathPart(copy\file), @proc)
  proc\stdout = ReplaceString(proc\stdout, copy\root, Left(AbsFile$, Len(copy\sourceRoot)))
  proc\stderr = ReplaceString(proc\stderr, copy\root, Left(AbsFile$, Len(copy\sourceRoot)))
  CleanupTempDir(copy\dir)

  ParseDiagnostics(proc\stdout, *c\errors(), *c\warnings())
  *c\timedOut = proc\timedOut
  *c\ok = Bool(proc\spawnFailed = #False And proc\exitCode = 0 And proc\timedOut = #False And ListSize(*c\errors()) = 0)

  If proc\spawnFailed
    *c\rawTail = "Compiler failed to start: " + CompilerExe$
  ElseIf *c\ok = #False And DiagnosticsNeedRaw(*c\errors())
    Protected combined$ = proc\stdout
    If TrimAll(proc\stderr) <> "" : combined$ + Chr(10) + proc\stderr : EndIf
    Protected stripped$ = StripCompilerNoise(combined$)
    If stripped$ = "" : stripped$ = TrimAll(proc\stderr) : EndIf
    If stripped$ = "" : stripped$ = "compiler produced no output" : EndIf
    ; last 10 lines
    Protected nLines.i = CountString(stripped$, Chr(10)) + 1
    Protected startLine.i = nLines - 9
    If startLine < 1 : startLine = 1 : EndIf
    Protected tail$ = ""
    Protected i.i
    For i = startLine To nLines
      If tail$ <> "" : tail$ + Chr(10) : EndIf
      tail$ + StringField(stripped$, i, Chr(10))
    Next
    *c\rawTail = tail$
  EndIf
EndProcedure

Procedure ToolCheck(IdValue.i, Args.i)
  Protected startMs.i = ElapsedMilliseconds()
  Protected compiler$ = ConfigCompiler()
  If compiler$ = ""
    SendTextResult(IdValue, "PureBasic compiler not found. Install PureBasic (or set PUREBASIC_HOME to its install dir) and restart the server.", #True)
    ProcedureReturn
  EndIf

  ; validate 'file' (string, min length 1, required) - shared validator
  Protected sOut.String   ; an *out.String must
  Protected issue$ = ValidateStrArg(Args, "file", 0, #True, @sOut)
  If issue$ <> ""
    SendInvalidParams(IdValue, "pb_check", issue$)
    ProcedureReturn
  EndIf
  Protected fileArg$ = sOut\s

  Protected rootOut.String
  issue$ = ValidateStrArg(Args, "projectRoot", 0, #False, @rootOut)
  If issue$ <> ""
    SendInvalidParams(IdValue, "pb_check", issue$)
    ProcedureReturn
  EndIf

  Protected abs$ = ResolvePath(fileArg$)
  If FileSize(abs$) = -1
    SendTextResult(IdValue, "File not found: " + abs$, #True)
    ProcedureReturn
  EndIf

  Protected res.CheckResT
  RunCheck(compiler$, abs$, rootOut\s, @res)
  If res\stagingError <> ""
    SendTextResult(IdValue, res\stagingError, #True)
    ProcedureReturn
  EndIf
  If gRequestCancelled : ProcedureReturn : EndIf

  ; metrics: one compile event, resolved path, real error parsing -
  ; ONLY on the success path
  Protected okBuckets.i = res\ok
  NewList msgs$()
  NewList buckets$()
  ForEach res\errors() : AddElement(msgs$()) : msgs$() = res\errors()\message : Next
  MetricsClassifyBuckets(msgs$(), buckets$())

  Protected output$ = FormatCheckResult(startMs, res\lineCount, res\ok, res\timedOut, res\errors(), res\warnings(), res\rawTail, fileArg$, res\sourceText, buckets$())
  MetricsAppend("pb_check", abs$, okBuckets, ListSize(msgs$()), buckets$(), ElapsedMilliseconds() - startMs)
  SendTextResult(IdValue, output$, Bool(Not res\ok))
EndProcedure
